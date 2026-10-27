import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'
import { buildInboundLeadGraph, resumeInboundLeadPlay, playStatusFromState } from '../inbound-lead/graph.js'
import { leadRepo } from '../../repositories/lead.repo.js'
import { executeAction } from '../../actions/executor.js'
import type { ReviewDecision } from '../../domain/db-types.js'

// Durable checkpoints are Postgres in production; the graph logic is tested with MemorySaver.
const app = buildInboundLeadGraph(new MemorySaver())

vi.mock('../../events/event-log.js', () => ({
  writeEvent: vi.fn().mockResolvedValue({})
}))

vi.mock('../../actions/executor.js', () => ({
  executeAction: vi.fn().mockResolvedValue({})
}))

vi.mock('../../actions/validator.js', () => ({
  validateAction: vi.fn().mockImplementation((res: any) => {
    if (res.type === 'request_human_review') return { approved: false, requiresHumanApproval: true }
    return { approved: true, requiresHumanApproval: false }
  })
}))

vi.mock('../../evidence/context-builder.js', () => ({
  buildDecisionSnapshot: vi.fn().mockResolvedValue({
    lead: { id: 'lead_1' },
    company: null,
    policies: [{ id: 'routing-1', rule_type: 'routing', is_active: true, priority: 40, version: 1, conditions: {}, actions: { max_open_leads_per_rep: 25 } }],
    ownerWorkloads: {},
    evidenceIds: [],
    agentName: 'system',
    agentVersion: 'v1.0.0',
    promptVersion: null,
    modelName: null
  })
}))

// No reps imported → RoutingAgent returns request_human_review (OWNER_LIST_EMPTY).
vi.mock('../../repositories/reps.repository.js', () => ({ listReps: vi.fn().mockResolvedValue([]) }))

vi.mock('../../repositories/lead.repo.js', () => ({
  leadRepo: {
    isDuplicate:           vi.fn().mockResolvedValue(false),
    // Default: return a recent play so the re-enrollment window has NOT elapsed.
    // Duplicate tests override isDuplicate→true; getLatestPlayForEmail returning
    // a recent play means the system correctly routes to mark_duplicate (not re-enroll).
    getLatestPlayForEmail: vi.fn().mockResolvedValue({
      status:         'completed',
      updated_at:     new Date().toISOString(),
      first_touch_at: new Date().toISOString(),
    }),
  }
}))

// Mock getDb() for route.ts's routing_state and external_identity queries.
// Returns empty data → RoutingAgent falls back to request_human_review,
// which is the correct behavior when no SF users are registered.
vi.mock('../../db/client.js', () => {
  const makeChain = (resolveValue: any) => {
    const chain: any = {
      from: () => chain,
      select: () => chain,
      eq: () => chain,
      single: () => Promise.resolve(resolveValue),
      // resolves the chain for non-single queries
      then: (resolve: any) => Promise.resolve(resolveValue).then(resolve),
    }
    return chain
  }
  return {
    getDb: () => makeChain({ data: null, error: null }),
    _resetDbClient: vi.fn(),
  }
})

// Mock Clearbit — workflow unit tests don't test external enrichment.
// The enrich node handles null (no match) via enrichment_skipped and continues.
// Workspace connectors come from the factory; none are connected in this test.
vi.mock('../../connectors/factory.js', () => ({
  getConnectors: () => ({
    hubspot: async () => null,
    salesforce: async () => null,
    apollo: async () => null,
  }),
}))

vi.mock('../../connectors/clearbit/clearbit.connector.js', () => ({
  ClearbitConnector: class {
    async connect() {}
    async enrichByEmail(_email: string) { return null }
  }
}))

vi.mock('../../agents/qualification/index.js', () => ({
  QualificationAgent: class {
    name = 'qualification-agent'
    version = 'v1.0.0'
    run(input: any) {
      return {
        type: 'qualify_lead',
        parameters: { is_icp_fit: input.lead.is_icp_fit ?? true },
        decisionRiskScore: 0.0,
        rawConfidence: 1.0,
      }
    }
    async execute(input: any) { return this.run(input) }
  }
}))

// AI qualification (v2): off unless a test switches it on.
const modelChoice = vi.hoisted(() => ({ chooseQualificationModel: vi.fn(async () => ({ kind: 'off' })), chooseRoutingModel: vi.fn(async () => ({ kind: 'off' })) }))
vi.mock('../inbound-lead/qualification-model.js', () => modelChoice)
vi.mock('../../agents/qualification/llm.js', () => ({
  QualificationAgentV2: class {
    name = 'qualification-agent'
    version = '2.0.0'
    promptVersion = 'test-prompt'
    async execute() {
      return {
        type: 'qualify_lead',
        parameters: {
          is_icp_fit: true, icp_tier: 'tier_1', model_tier: 'tier_1', rules_tier: 'not_icp', review_required: 'MODEL_RULES_DISAGREE',
          model_context: { outcome: 'model', provider: 'ollama', model: 'qwen2.5:1.5b', reportedModel: 'qwen2.5:1.5b', modelDigest: 'd1', promptVersion: 'test-prompt', rulesTier: 'not_icp', modelTier: 'tier_1', fallbackReason: null },
        },
        decisionRiskScore: 0.9, rawConfidence: 0.7,
      }
    }
  },
}))

vi.mock('../../agents/routing/index.js', () => ({
  RoutingAgent: class {
    name = 'routing-agent'
    version = 'v1.0.0'
    run(input: any) {
      if (input.lead.requires_human_approval) {
        return { type: 'request_human_review', decisionRiskScore: 0.0, rawConfidence: 1.0 }
      }
      return { type: 'assign_owner', decisionRiskScore: 0.0, rawConfidence: 1.0 }
    }
    async execute(input: any) { return this.run(input) }
  }
}))

describe('inbound-lead workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(leadRepo.isDuplicate).mockResolvedValue(false)
    vi.mocked(leadRepo.getLatestPlayForEmail).mockResolvedValue({
      status:         'completed',
      updated_at:     new Date().toISOString(),
      first_touch_at: new Date().toISOString(),
    })
  })

  it('runs happy path', async () => {
    const initialState = {
      organizationId: 'org_1',
      workflowRunId: 'wr_1',
      leadId: 'lead_1',
      playInstanceId: 'play_1',
      lead: { id: 'lead_1', organization_id: 'org_1', email: 'test@example.com' },
    }
    const result = await app.invoke(initialState, { configurable: { thread_id: 'wr_1' } })
    expect(result.currentStep).toBe('complete')
  })

  it('not ICP path', async () => {
    const initialState = {
      organizationId: 'org_1',
      workflowRunId: 'wr_2',
      leadId: 'lead_2',
      playInstanceId: 'play_2',
      lead: { id: 'lead_2', organization_id: 'org_1', email: 'test@example.com', is_icp_fit: false },
    }
    const result = await app.invoke(initialState, { configurable: { thread_id: 'wr_2' } })
    expect(result.currentStep).toBe('mark_nurture')
  })

  it('duplicate path', async () => {
    vi.mocked(leadRepo.isDuplicate).mockResolvedValue(true)
    const initialState = {
      organizationId: 'org_1',
      workflowRunId: 'wr_3',
      leadId: 'lead_3',
      playInstanceId: 'play_3',
      lead: { id: 'lead_3', organization_id: 'org_1', email: 'test@example.com' },
    }
    const result = await app.invoke(initialState, { configurable: { thread_id: 'wr_3' } })
    expect(result.currentStep).toBe('mark_duplicate')
  })

  it('human review path', async () => {
    const initialState = {
      organizationId: 'org_1',
      workflowRunId: 'wr_4',
      leadId: 'lead_4',
      playInstanceId: 'play_4',
      lead: { id: 'lead_4', organization_id: 'org_1', email: 'test@example.com', requires_human_approval: true },
    }
    const result = await app.invoke(initialState, { configurable: { thread_id: 'wr_4' } })
    expect(result.currentStep).toBe('route')
    const state = await app.getState({ configurable: { thread_id: 'wr_4' } })
    expect(state.next).toEqual(['human_review'])
    expect(playStatusFromState(state)).toBe('paused')
  })
})

describe('inbound-lead workflow — AI qualification (v2)', () => {
  const run = (id: string) => app.invoke({
    organizationId: 'org_1', workflowRunId: id, leadId: `lead_${id}`, playInstanceId: `play_${id}`,
    lead: { id: `lead_${id}`, organization_id: 'org_1', email: 'test@example.com' },
  } as any, { configurable: { thread_id: id } })

  it('gate says fallback → rules decide and a model_fallback event is written (never silent)', async () => {
    const { writeEvent } = await import('../../events/event-log.js')
    vi.mocked(writeEvent).mockClear()
    modelChoice.chooseQualificationModel.mockResolvedValueOnce({ kind: 'fallback', reason: 'MODEL_UNREACHABLE', provider: 'ollama', model: 'qwen2.5:1.5b', evaluationId: 'ev1' } as never)
    await run('wr_ai_1')
    const calls = vi.mocked(writeEvent).mock.calls.map(c => c[0] as any)
    const fb = calls.find(c => c.eventType === 'model_fallback')
    expect(fb).toMatchObject({ errorCode: 'MODEL_UNREACHABLE', eventStatus: 'skipped', modelProvider: 'ollama' })
    expect(fb.decisionSnapshot.modelContext).toMatchObject({ outcome: 'fallback', fallbackReason: 'MODEL_UNREACHABLE', evaluationId: 'ev1' })
    const proposed = calls.find(c => c.eventType === 'action_proposed' && c.actorId === 'qualification-agent')
    expect(proposed.agentVersion).toBe('v1.0.0')
  })

  it('model and rules disagree on fit → the play pauses for a person, with the reason and model recorded', async () => {
    const { writeEvent } = await import('../../events/event-log.js')
    vi.mocked(writeEvent).mockClear()
    vi.mocked(executeAction).mockClear()
    modelChoice.chooseQualificationModel.mockResolvedValueOnce({ kind: 'on', client: {}, modelDigest: 'd1', evaluatedDigest: 'd1', evaluationId: 'ev1' } as never)
    await run('wr_ai_2')
    const state = await app.getState({ configurable: { thread_id: 'wr_ai_2' } })
    expect(state.next).toEqual(['human_review'])
    const proposed = vi.mocked(writeEvent).mock.calls.map(c => c[0] as any).find(c => c.eventType === 'action_proposed' && c.actorId === 'qualification-agent')
    expect(proposed).toMatchObject({ agentVersion: '2.0.0', modelProvider: 'ollama', modelName: 'qwen2.5:1.5b', promptVersion: 'test-prompt' })
    expect(proposed.decisionSnapshot).toMatchObject({ promptVersion: 'test-prompt', modelName: 'qwen2.5:1.5b', modelContext: { outcome: 'model', modelDigest: 'd1', temperature: 0 } })
    const review = vi.mocked(executeAction).mock.calls.map(c => c[0] as any).find(a => a.type === 'request_human_review')
    expect(review.rationale.reasonCodes[0]).toBe('MODEL_RULES_DISAGREE')
  })
})

describe('inbound-lead workflow — AI routing (v2)', () => {
  it('routing gate says fallback → v1 routing and a model_fallback event from the routing agent', async () => {
    const { writeEvent } = await import('../../events/event-log.js')
    vi.mocked(writeEvent).mockClear()
    modelChoice.chooseRoutingModel.mockResolvedValueOnce({ kind: 'fallback', reason: 'MODEL_EVALUATION_OUTDATED', provider: 'gemini', model: 'gemini-3.5-flash-lite', evaluationId: 'ev9' } as never)
    await app.invoke({
      organizationId: 'org_1', workflowRunId: 'wr_rt_1', leadId: 'lead_wr_rt_1', playInstanceId: 'play_wr_rt_1',
      lead: { id: 'lead_wr_rt_1', organization_id: 'org_1', email: 'test@example.com' },
    } as any, { configurable: { thread_id: 'wr_rt_1' } })
    const fb = vi.mocked(writeEvent).mock.calls.map(c => c[0] as any).find(c => c.eventType === 'model_fallback')
    expect(fb).toMatchObject({ actorId: 'routing-agent', errorCode: 'MODEL_EVALUATION_OUTDATED', modelProvider: 'gemini' })
    expect(fb.decisionSnapshot.routingModelContext).toMatchObject({ outcome: 'fallback', evaluationId: 'ev9' })
  })
})

describe('inbound-lead workflow — resuming after human review', () => {
  const decision = (over: Partial<ReviewDecision> = {}): ReviewDecision => ({
    decision: 'approved', kind: 'routing', owner_id: '005REP', owner_name: 'Alice Ng',
    note: null, actor_user_id: 'user-admin', decided_at: '2026-10-26T10:00:00.000Z', ...over,
  })
  const pause = async (run: string) => {
    await app.invoke({
      organizationId: 'org_1', workflowRunId: run, leadId: `lead_${run}`, playInstanceId: `play_${run}`,
      lead: { id: `lead_${run}`, organization_id: 'org_1', email: 'test@example.com', requires_human_approval: true },
    } as any, { configurable: { thread_id: run } })
    vi.mocked(executeAction).mockClear()
  }
  const executedTypes = () => vi.mocked(executeAction).mock.calls.map(c => (c[0] as any).type)

  beforeEach(() => {
    vi.mocked(leadRepo.isDuplicate).mockResolvedValue(false)
  })

  it('approved: assigns the chosen rep through the executor, then runs first touch to the end', async () => {
    await pause('wr_r1')
    const r = await resumeInboundLeadPlay('wr_r1', decision(), app)
    expect(r).toEqual({ status: 'completed', resumed: 'decision' })
    const assign = vi.mocked(executeAction).mock.calls.find(c => (c[0] as any).type === 'assign_owner')![0] as any
    expect(assign).toMatchObject({
      actionId: 'assign_owner_human_review',
      idempotencyKey: 'org_1:wr_r1:assign_owner_human_review',
      parameters: { recommended_owner_id: '005REP', owner_name: 'Alice Ng', queue_name: 'human_review' },
    })
    expect(executedTypes()).toContain('start_sequence')
    const state = await app.getState({ configurable: { thread_id: 'wr_r1' } })
    expect(state.values.currentStep).toBe('complete')
  })

  it('rejected: goes to nurture, no rep assigned', async () => {
    await pause('wr_r2')
    const r = await resumeInboundLeadPlay('wr_r2', decision({ decision: 'rejected', owner_id: null, owner_name: null }), app)
    expect(r.status).toBe('completed')
    expect(executedTypes()).toEqual(['mark_nurture'])
    expect((vi.mocked(executeAction).mock.calls[0][0] as any).rationale.reasonCodes).toEqual(['HUMAN_REJECTED'])
  })

  it('resuming twice does nothing the second time (job retry / double click)', async () => {
    await pause('wr_r3')
    await resumeInboundLeadPlay('wr_r3', decision(), app)
    vi.mocked(executeAction).mockClear()
    expect(await resumeInboundLeadPlay('wr_r3', decision(), app)).toEqual({ status: 'completed', resumed: 'nothing_to_do' })
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('an invalid decision is never applied and the play stays paused', async () => {
    await pause('wr_r4')
    await expect(resumeInboundLeadPlay('wr_r4', decision({ owner_id: null }), app)).rejects.toThrow('REVIEW_DECISION_INVALID')
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('sequence sign-off: first touch pauses durably; rejected → no sequence (manual follow-up)', async () => {
    const { validateAction } = await import('../../actions/validator.js')
    vi.mocked(validateAction).mockImplementation(async (a: any) =>
      a.type === 'start_sequence' ? { approved: true, requiresHumanApproval: true } as any : { approved: true, requiresHumanApproval: false } as any)
    try {
      const config = { configurable: { thread_id: 'wr_s1' } }
      await app.invoke({
        organizationId: 'org_1', workflowRunId: 'wr_s1', leadId: 'lead_s1', playInstanceId: 'play_s1',
        lead: { id: 'lead_s1', organization_id: 'org_1', email: 'test@example.com' },
      } as any, config)
      expect(playStatusFromState(await app.getState(config))).toBe('paused')
      expect(executedTypes()).toContain('request_human_review')
      expect(executedTypes()).not.toContain('start_sequence')

      vi.mocked(executeAction).mockClear()
      const r = await resumeInboundLeadPlay('wr_s1', decision({ kind: 'sequence', decision: 'rejected', owner_id: null, owner_name: null }), app)
      expect(r.status).toBe('completed')
      const seq = vi.mocked(executeAction).mock.calls.find(c => (c[0] as any).type === 'start_sequence')![0] as any
      expect(seq.parameters).toMatchObject({ plan: 'manual', reason_code: 'HUMAN_REJECTED_SEQUENCE' })
    } finally {
      vi.mocked(validateAction).mockImplementation(async (res: any) =>
        res.type === 'request_human_review' ? { approved: false, requiresHumanApproval: true } as any : { approved: true, requiresHumanApproval: false } as any)
    }
  })

  it('unknown workflow run → CHECKPOINT_NOT_FOUND', async () => {
    await expect(resumeInboundLeadPlay('wr_missing', decision(), app)).rejects.toThrow('CHECKPOINT_NOT_FOUND')
  })
})

// Real Postgres: set CHECKPOINT_TEST_DB_URL to a throwaway database (never the shared one).
const PG_URL = process.env.CHECKPOINT_TEST_DB_URL
describe.skipIf(!PG_URL)('durable checkpoints (PostgresSaver)', () => {
  it('a paused play survives a restart: a new checkpointer instance resumes it', async () => {
    const { createPostgresCheckpointer } = await import('../checkpointer.js')
    const run = `wr_pg_${Date.now()}`
    const config = { configurable: { thread_id: run } }

    const saverA = await createPostgresCheckpointer(PG_URL!)
    const before = buildInboundLeadGraph(saverA)
    await before.invoke({
      organizationId: 'org_1', workflowRunId: run, leadId: 'lead_pg', playInstanceId: 'play_pg',
      lead: { id: 'lead_pg', organization_id: 'org_1', email: 'test@example.com', requires_human_approval: true },
    } as any, config)
    expect(playStatusFromState(await before.getState(config))).toBe('paused')
    await (saverA as any).end()   // "restart": drop every connection

    const saverB = await createPostgresCheckpointer(PG_URL!)
    const after = buildInboundLeadGraph(saverB)
    expect(playStatusFromState(await after.getState(config))).toBe('paused')
    vi.mocked(executeAction).mockClear()
    const r = await resumeInboundLeadPlay(run, {
      decision: 'approved', kind: 'routing', owner_id: '005REP', owner_name: 'Alice Ng',
      note: null, actor_user_id: 'user-admin', decided_at: new Date().toISOString(),
    }, after)
    expect(r).toEqual({ status: 'completed', resumed: 'decision' })
    expect(vi.mocked(executeAction).mock.calls.map(c => (c[0] as any).type)).toContain('assign_owner')
    await (saverB as any).end()
  })
})
