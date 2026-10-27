/**
 * replay.ts — run any decision-maker over (a) the golden dataset and (b) recorded
 * decision_snapshots, and report agreement.
 *
 * Pure: no DB, no network. Callers pass in events (see replay.repository.ts) and a Decider.
 * A Decider that throws is recorded as an error for that case (never skipped silently).
 * Snapshots that lack something the decision needs are reported as `skipped` with a reason.
 */

import type { EventLog } from '../domain/db-types.js'
import type { IcpTier, ProposedAction, QualificationInput } from '../agents/qualification/types.js'
import type { RoutingInput } from '../agents/routing/types.js'
import { qualificationAgent } from '../agents/qualification/index.js'
import { routingAgent } from '../agents/routing/index.js'
import { GOLDEN_CASES, GOLDEN_DATASET_VERSION } from './datasets/golden.js'
import { buildQualificationInput, buildRoutingInput } from './build.js'
import type { ExpectedRouting, GoldenCase } from './types.js'

export type Decider = {
  name: string
  version: string
  qualify(input: QualificationInput): Promise<ProposedAction>
  route?(input: RoutingInput): Promise<ProposedAction>   // absent = qualification-only decider
}

/** The v1 rule-based agents, as a Decider (the baseline every model is compared with). */
export const v1Decider: Decider = {
  name: 'v1-rules',
  version: `${qualificationAgent.version}+${routingAgent.version}`,
  qualify: async input => qualificationAgent.run(input),
  route: async input => routingAgent.run(input),
}

// ── Normalised outcomes ──────────────────────────────────────────────────────────

export type RoutingOutcomeSummary =
  | { action: 'assign_owner'; ownerId: string; queue: string }
  | { action: 'request_human_review'; reason: string }
  | { action: 'other'; type: string }

export function tierOf(a: ProposedAction): IcpTier | null {
  const t = (a.parameters as { icp_tier?: unknown })?.icp_tier
  return t === 'tier_1' || t === 'tier_2' || t === 'not_icp' ? t : null
}

export function routingOutcomeOf(a: ProposedAction): RoutingOutcomeSummary {
  const p = (a.parameters ?? {}) as { recommended_owner_id?: string; queue_name?: string; reason_codes?: string[] }
  if (a.type === 'assign_owner') return { action: 'assign_owner', ownerId: p.recommended_owner_id ?? '', queue: p.queue_name ?? '' }
  if (a.type === 'request_human_review') return { action: 'request_human_review', reason: p.reason_codes?.[0] ?? '' }
  return { action: 'other', type: a.type }
}

function sameRouting(a: RoutingOutcomeSummary, b: RoutingOutcomeSummary | ExpectedRouting): boolean {
  if (a.action !== b.action) return false
  if (a.action === 'assign_owner' && b.action === 'assign_owner') return a.ownerId === b.ownerId && a.queue === b.queue
  if (a.action === 'request_human_review' && b.action === 'request_human_review') return a.reason === b.reason
  return a.action === 'other' && b.action === 'other' && a.type === b.type
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export type Tally = { agreed: number; total: number; errors: number; rate: number | null }

function tally(rows: Array<{ agrees: boolean; error?: string }>): Tally {
  const total = rows.length
  const agreed = rows.filter(r => r.agrees).length
  return { agreed, total, errors: rows.filter(r => r.error).length, rate: total ? agreed / total : null }
}

// ── (a) Golden dataset ───────────────────────────────────────────────────────────

export type GoldenCaseResult = {
  caseId: string
  tags: string[]
  qualification: { expected: IcpTier; acceptable: IcpTier[]; actual: IcpTier | null; agrees: boolean; error?: string }
  routing?: { expected: ExpectedRouting; actual: RoutingOutcomeSummary | null; agrees: boolean; error?: string }
}

export type GoldenReport = {
  datasetVersion: string
  decider: { name: string; version: string }
  results: GoldenCaseResult[]
  summary: {
    qualification: Tally
    routing: Tally | null          // null when the decider does not route
    injection: Tally               // qualification agreement on injection-tagged cases
    byTag: Record<string, Tally>   // qualification agreement per tag
  }
}

export async function runGolden(decider: Decider, cases: GoldenCase[] = GOLDEN_CASES): Promise<GoldenReport> {
  const results: GoldenCaseResult[] = []
  for (const c of cases) {
    const acceptable = c.expected.acceptableTiers ?? [c.expected.tier]
    let qualAction: ProposedAction | null = null
    const qualification: GoldenCaseResult['qualification'] = { expected: c.expected.tier, acceptable, actual: null, agrees: false }
    try {
      qualAction = await decider.qualify(buildQualificationInput(c))
      qualification.actual = tierOf(qualAction)
      qualification.agrees = qualification.actual !== null && acceptable.includes(qualification.actual)
      if (qualification.actual === null) qualification.error = 'DECIDER_OUTPUT_HAS_NO_TIER'
    } catch (e) {
      qualification.error = errText(e)
    }

    const result: GoldenCaseResult = { caseId: c.id, tags: c.tags, qualification }
    if (c.expected.routing && decider.route) {
      const routing: NonNullable<GoldenCaseResult['routing']> = { expected: c.expected.routing, actual: null, agrees: false }
      try {
        if (!qualAction) throw new Error('ROUTING_SKIPPED_QUALIFICATION_FAILED')
        routing.actual = routingOutcomeOf(await decider.route(buildRoutingInput(c, qualAction)))
        routing.agrees = sameRouting(routing.actual, c.expected.routing)
      } catch (e) {
        routing.error = errText(e)
      }
      result.routing = routing
    }
    results.push(result)
  }

  const tags = [...new Set(cases.flatMap(c => c.tags))].sort()
  const byTag: Record<string, Tally> = {}
  for (const t of tags) byTag[t] = tally(results.filter(r => r.tags.includes(t)).map(r => r.qualification))

  return {
    datasetVersion: GOLDEN_DATASET_VERSION,
    decider: { name: decider.name, version: decider.version },
    results,
    summary: {
      qualification: tally(results.map(r => r.qualification)),
      routing: decider.route ? tally(results.flatMap(r => (r.routing ? [r.routing] : []))) : null,
      injection: byTag.injection ?? tally([]),
      byTag,
    },
  }
}

// ── (b) Recorded decision_snapshots ──────────────────────────────────────────────

export const QUALIFICATION_AGENT_NAME = qualificationAgent.name
export const ROUTING_AGENT_NAME = routingAgent.name

export type SnapshotSkipReason =
  | 'EVENT_NOT_AN_AGENT_PROPOSAL'
  | 'SNAPSHOT_MISSING_LEAD'
  | 'RECORDED_DECISION_MISSING'
  | 'SNAPSHOT_MISSING_ROUTING_CONTEXT'   // routed before routingContext was recorded
  | 'DECIDER_DOES_NOT_ROUTE'

export type SnapshotReplayResult = {
  eventId: string
  leadId: string | null
  occurredAt: string
  kind: 'qualification' | 'routing'
  recordedBy: { agent: string | null; version: string | null; model: string | null }
} & (
  | { status: 'skipped'; reason: SnapshotSkipReason }
  | { status: 'error'; error: string; recorded: unknown }
  | { status: 'replayed'; agrees: boolean; recorded: IcpTier | RoutingOutcomeSummary; actual: IcpTier | RoutingOutcomeSummary | null }
)

export type SnapshotReport = {
  decider: { name: string; version: string }
  results: SnapshotReplayResult[]
  summary: { qualification: Tally; routing: Tally; skipped: Record<string, number> }
}

/**
 * Replays `action_proposed` events written by the qualification/routing agents.
 * Compares the decider's answer with what was recorded at the time (agreement = "would it have
 * decided the same"), using only what the snapshot holds.
 */
export async function replaySnapshots(decider: Decider, events: EventLog[]): Promise<SnapshotReport> {
  const results: SnapshotReplayResult[] = []

  for (const ev of events) {
    const base = {
      eventId: ev.id, leadId: ev.lead_id, occurredAt: ev.occurred_at,
      recordedBy: { agent: ev.actor_id, version: ev.agent_version, model: ev.model_name },
    }
    const kind = ev.actor_id === ROUTING_AGENT_NAME ? 'routing' as const : 'qualification' as const
    const snap = ev.decision_snapshot
    const recordedAction = ev.proposed_action as unknown as ProposedAction | null

    if (ev.event_type !== 'action_proposed' || (ev.actor_id !== QUALIFICATION_AGENT_NAME && ev.actor_id !== ROUTING_AGENT_NAME)) {
      results.push({ ...base, kind, status: 'skipped', reason: 'EVENT_NOT_AN_AGENT_PROPOSAL' }); continue
    }
    if (!snap?.lead) { results.push({ ...base, kind, status: 'skipped', reason: 'SNAPSHOT_MISSING_LEAD' }); continue }
    if (!recordedAction?.type) { results.push({ ...base, kind, status: 'skipped', reason: 'RECORDED_DECISION_MISSING' }); continue }

    if (kind === 'qualification') {
      const recorded = tierOf(recordedAction)
      if (!recorded) { results.push({ ...base, kind, status: 'skipped', reason: 'RECORDED_DECISION_MISSING' }); continue }
      try {
        const actual = tierOf(await decider.qualify({
          lead: snap.lead, company: snap.company ?? null, enrichmentEvidence: [],
          icpPolicyRules: (snap.policies ?? []).filter(p => p.rule_type === 'icp_filter'),
        }))
        results.push({ ...base, kind, status: 'replayed', recorded, actual, agrees: actual === recorded })
      } catch (e) {
        results.push({ ...base, kind, status: 'error', error: errText(e), recorded })
      }
      continue
    }

    if (!decider.route) { results.push({ ...base, kind, status: 'skipped', reason: 'DECIDER_DOES_NOT_ROUTE' }); continue }
    const ctx = snap.routingContext
    if (!ctx) { results.push({ ...base, kind, status: 'skipped', reason: 'SNAPSHOT_MISSING_ROUTING_CONTEXT' }); continue }
    const recorded = routingOutcomeOf(recordedAction)
    try {
      const actual = routingOutcomeOf(await decider.route({
        lead: snap.lead,
        company: snap.company ?? null,
        // Recorded qualification is not in the routing snapshot; v1 routing does not read it.
        qualificationResult: { type: 'qualify_lead', parameters: { icp_tier: snap.lead.icp_tier }, decisionRiskScore: 0, rawConfidence: 1 },
        availableOwners: ctx.owners,
        ownerWorkloads: snap.ownerWorkloads ?? {},
        territoryPolicyRules: (snap.policies ?? []).filter(p => p.rule_type === 'territory'),
        routingState: {
          id: '', organization_id: ev.organization_id, queue_name: 'inbound-leads', counter: ctx.roundRobinCounter,
          last_assigned_owner_id: null, last_assigned_at: null, created_at: ev.occurred_at, updated_at: ev.occurred_at,
        },
        maxOpenLeadsPerRep: ctx.maxOpenLeadsPerRep,
      }))
      results.push({ ...base, kind, status: 'replayed', recorded, actual, agrees: sameRouting(actual, recorded) })
    } catch (e) {
      results.push({ ...base, kind, status: 'error', error: errText(e), recorded })
    }
  }

  const scored = (k: 'qualification' | 'routing') => results
    .filter(r => r.kind === k && r.status !== 'skipped')
    .map(r => (r.status === 'replayed' ? { agrees: r.agrees } : { agrees: false, error: r.status === 'error' ? r.error : undefined }))
  const skipped: Record<string, number> = {}
  for (const r of results) if (r.status === 'skipped') skipped[r.reason] = (skipped[r.reason] ?? 0) + 1

  return {
    decider: { name: decider.name, version: decider.version },
    results,
    summary: { qualification: tally(scored('qualification')), routing: tally(scored('routing')), skipped },
  }
}
