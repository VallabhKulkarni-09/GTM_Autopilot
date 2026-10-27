/**
 * graph.ts — LangGraph StateGraph for the inbound-lead play.
 *
 * Node order:
 *   validate → [mark_duplicate | enrich]
 *   enrich   → account_match
 *   account_match → [first_touch (bypass qual for active deals) | qualify]
 *   qualify  → [mark_nurture | route]
 *   route    → [human_review | first_touch]
 *   first_touch → complete
 */

import { StateGraph, START, END, Command, type BaseCheckpointSaver, type StateSnapshot } from '@langchain/langgraph'
import { getDb }          from '../../db/client.js'
import { getCheckpointer } from '../checkpointer.js'
import { humanReview }   from './nodes/human-review.js'
import type { ReviewDecision } from '../../domain/db-types.js'
import { WorkflowState } from './state.js'
import { validate }      from './nodes/validate.js'
import { enrich }        from './nodes/enrich.js'
import { accountMatch }  from './nodes/account-match.js'
import { qualify }       from './nodes/qualify.js'
import { route }         from './nodes/route.js'
import { firstTouch }    from './nodes/first-touch.js'
import { markDuplicate } from './nodes/mark-duplicate.js'
import { markNurture }   from './nodes/mark-nurture.js'
import { complete }      from './nodes/complete.js'

// ─── Graph State Definition ────────────────────────────────────────────────────

const graphState = {
  organizationId:       { value: (x: string, y: string) => y ?? x },
  workflowRunId:        { value: (x: string, y: string) => y ?? x },
  leadId:               { value: (x: string, y: string) => y ?? x },
  playInstanceId:       { value: (x: string, y: string) => y ?? x },
  lead:                 { value: (x: any, y: any) => y ?? x },
  company:              { value: (x: any, y: any) => y ?? x },
  evidence:             { value: (x: any[], y: any[]) => y ?? x, default: () => [] },
  qualificationResult:  { value: (x: any, y: any) => y ?? x },
  routingResult:        { value: (x: any, y: any) => y ?? x },
  reviewDecision:       { value: (x: any, y: any) => y ?? x, default: () => null },
  currentStep:          { value: (x: string, y: string) => y ?? x },
  error:                { value: (x: string | null, y: string | null) => y ?? x },
}

// ─── Graph Definition ──────────────────────────────────────────────────────────

const workflow = new StateGraph({ channels: graphState as any })
  .addNode('validate',       validate as any)
  .addNode('mark_duplicate', markDuplicate as any)
  .addNode('enrich',         enrich as any)
  .addNode('account_match',  accountMatch as any)
  .addNode('qualify',        qualify as any)
  .addNode('mark_nurture',   markNurture as any)
  .addNode('route',          route as any)
  .addNode('human_review',   humanReview as any)
  .addNode('first_touch',    firstTouch as any)
  .addNode('complete',       complete as any)

  // validate → mark_duplicate (if dup) | enrich (net-new)
  .addEdge(START, 'validate')
  .addConditionalEdges('validate', (state: any) => {
    return state.lead?.is_duplicate ? 'mark_duplicate' : 'enrich'
  })
  .addEdge('mark_duplicate', END)

  // enrich → account_match (always)
  .addEdge('enrich', 'account_match')

  // account_match → first_touch (bypass: active deal found)
  //              → qualify (net-new or account-only match)
  .addConditionalEdges('account_match', (state: any) => {
    if (state.routingResult?._bypassQualification === true) {
      return 'first_touch'   // active deal: skip SDR qualification entirely
    }
    return 'qualify'
  })

  // qualify → mark_nurture (not ICP) | route (ICP fit)
  .addConditionalEdges('qualify', (state: any) => {
    return state.qualificationResult?.parameters?.is_icp_fit === false
      ? 'mark_nurture'
      : 'route'
  })
  .addEdge('mark_nurture', END)

  // route → human_review | first_touch
  .addConditionalEdges('route', (state: any) => {
    if (state.routingResult?.type === 'request_human_review') return 'human_review'
    return 'first_touch'
  })

  // human_review (after a person decides) → first_touch (approved: rep assigned) | mark_nurture (rejected)
  .addConditionalEdges('human_review', (state: any) =>
    state.reviewDecision?.decision === 'rejected' ? 'mark_nurture' : 'first_touch')
  .addEdge('first_touch',  'complete')
  .addEdge('complete',     END)

/** Compiles the play with a given checkpointer (tests pass a MemorySaver). */
export function buildInboundLeadGraph(checkpointer: BaseCheckpointSaver) {
  return workflow.compile({ checkpointer })
}

type InboundLeadApp = ReturnType<typeof buildInboundLeadGraph>
let compiled: Promise<InboundLeadApp> | null = null

/** The play compiled with the durable Postgres checkpointer (lazy; worker process only). */
export function getInboundLeadApp(): Promise<InboundLeadApp> {
  if (!compiled) {
    compiled = getCheckpointer().then(buildInboundLeadGraph).catch(err => { compiled = null; throw err })
  }
  return compiled
}

export type PlayRunStatus = 'paused' | 'running' | 'completed'

/** paused = waiting at an interrupt; completed = graph reached END; running = steps left (crash mid-run). */
export function playStatusFromState(snapshot: StateSnapshot): PlayRunStatus {
  if (snapshot.tasks.some(t => (t.interrupts?.length ?? 0) > 0)) return 'paused'
  return snapshot.next.length === 0 ? 'completed' : 'running'
}

// ─── Connector Registry ────────────────────────────────────────────────────────

/**
 * createConnectorRegistry — loads real connector instances per org.
 * Connectors are initialized lazily; nodes that need them call this.
 * Currently returns a lightweight registry shape; connectors connect
 * on first use via their own connect() methods inside the nodes.
 */
export function createConnectorRegistry(_organizationId: string) {
  // Connectors are instantiated inside individual nodes (enrich, first-touch)
  // because they need org-specific credentials loaded from connector_config.
  // This registry can be extended to pass pre-connected instances in v2.
  return {}
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

/**
 * runInboundLeadPlay
 *
 * Called by the BullMQ worker after creating the lead and play_instance.
 * The worker passes _leadId, _playInstanceId, and _workflowRunId in the payload
 * so the graph uses real DB UUIDs — never synthetic generated IDs.
 */
export async function runInboundLeadPlay(
  organizationId: string,
  hubspotPayload: any
): Promise<{ playInstanceId: string; status: string }> {
  // Use real IDs created by the worker — never generate new ones here
  const leadId         = hubspotPayload._leadId        as string
  const playInstanceId = hubspotPayload._playInstanceId as string
  const workflowRunId  = hubspotPayload._workflowRunId  as string

  if (!leadId || !playInstanceId || !workflowRunId) {
    throw new Error(
      '[graph] runInboundLeadPlay requires _leadId, _playInstanceId, and _workflowRunId ' +
      'in hubspotPayload. These must be the UUIDs created by inbound-lead.worker.ts.'
    )
  }

  const properties = hubspotPayload.properties ?? {}

  const initialState = {
    organizationId,
    workflowRunId,
    leadId,
    playInstanceId,
    lead: {
      id:              leadId,
      organization_id: organizationId,
      email:           properties.email ?? hubspotPayload.email ?? '',
      first_name:      properties.firstname ?? null,
      last_name:       properties.lastname ?? null,
      title:           properties.jobtitle ?? null,
      phone:           properties.phone ?? null,
      stage:           'new',
      form_submitted_at: hubspotPayload.occurredAt
        ? new Date(hubspotPayload.occurredAt).toISOString()
        : new Date().toISOString(),
      source:          `hubspot:${hubspotPayload.subscriptionType ?? 'form'}`,
      raw_payload:     hubspotPayload,
      is_duplicate:    false,
      is_icp_fit:      null,
      icp_score:       null,
      icp_tier:        null,
      created_at:      new Date().toISOString(),
      updated_at:      new Date().toISOString(),
    },
    company:             null,
    evidence:            [],
    qualificationResult: null,
    routingResult:       null,
    currentStep:         'start',
    error:               null,
  }

  // Load the real lead row from DB — the worker always inserts it before calling this function.
  // This ensures company_id and any worker-side mutations are reflected in the graph's initial state.
  const { data: dbLead } = await getDb()
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .single()

  if (dbLead) {
    Object.assign(initialState.lead, dbLead)
  }

  const app = await getInboundLeadApp()
  const config = { configurable: { thread_id: workflowRunId } }
  await app.invoke(initialState as any, config)

  return { playInstanceId, status: playStatusFromState(await app.getState(config)) }
}

/**
 * Resumes a play after a human decision. Safe to call more than once (job retries):
 *   waiting at an interrupt → resume with the decision
 *   steps left, no interrupt (a resume crashed half-way) → continue from the last checkpoint
 *   already finished → nothing to do
 */
export async function resumeInboundLeadPlay(
  workflowRunId: string,
  decision: ReviewDecision,
  app?: InboundLeadApp,
): Promise<{ status: PlayRunStatus; resumed: 'decision' | 'continued' | 'nothing_to_do' }> {
  const graph = app ?? await getInboundLeadApp()
  const config = { configurable: { thread_id: workflowRunId } }
  const before = await graph.getState(config)
  const beforeStatus = playStatusFromState(before)

  if (before.values && Object.keys(before.values).length === 0 && before.next.length === 0) {
    throw new Error(`CHECKPOINT_NOT_FOUND: no saved state for workflow run ${workflowRunId}`)
  }
  if (beforeStatus === 'completed') return { status: 'completed', resumed: 'nothing_to_do' }

  await graph.invoke(beforeStatus === 'paused' ? new Command({ resume: decision }) : null as any, config)
  return { status: playStatusFromState(await graph.getState(config)), resumed: beforeStatus === 'paused' ? 'decision' : 'continued' }
}
