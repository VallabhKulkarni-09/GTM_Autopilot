import { describe, it, expect } from 'vitest'
import { runGolden, replaySnapshots, v1Decider, type Decider } from '../replay.js'
import { GOLDEN_CASES } from '../datasets/golden.js'
import { buildQualificationInput, buildRoutingInput, GOLDEN_ORG_ID } from '../build.js'
import { qualificationAgent } from '../../agents/qualification/index.js'
import { routingAgent } from '../../agents/routing/index.js'
import type { DecisionSnapshot, EventLog } from '../../domain/db-types.js'
import type { ProposedAction } from '../../agents/qualification/types.js'

const byId = (id: string) => GOLDEN_CASES.find(c => c.id === id)!
const disagreeCount = (area: 'qualification' | 'routing') => GOLDEN_CASES.filter(c => c.v1Disagrees?.includes(area)).length

function event(over: Partial<EventLog> & { decision_snapshot: DecisionSnapshot; proposed_action: unknown }): EventLog {
  return {
    id: `ev-${Math.random().toString(36).slice(2)}`, organization_id: GOLDEN_ORG_ID, workflow_run_id: 'run-1',
    play_instance_id: null, lead_id: over.decision_snapshot.lead.id, event_type: 'action_proposed', actor_type: 'agent',
    actor_id: qualificationAgent.name, agent_version: qualificationAgent.version, model_provider: null, model_name: null,
    prompt_version: null, candidate_actions: null, policy_rule_id: null, policy_name: null, policy_passed: null,
    policy_decision: null, external_system: null, external_id: null, idempotency_key: null, event_status: 'success',
    error_code: null, error_message: null, error_raw: null, duration_ms: null,
    occurred_at: '2026-10-27T00:00:00.000Z', created_at: '2026-10-27T00:00:00.000Z',
    ...over, proposed_action: over.proposed_action as Record<string, unknown>,
  }
}

/** A recorded qualification + routing pair for a golden case, as the live pipeline writes them. */
function recordedPair(caseId: string, withRoutingContext = true) {
  const c = byId(caseId)
  const qIn = buildQualificationInput(c)
  const q = qualificationAgent.run(qIn)
  const rIn = buildRoutingInput(c, q)
  const r = routingAgent.run(rIn)
  const snap: DecisionSnapshot = {
    lead: qIn.lead, company: qIn.company, policies: [...qIn.icpPolicyRules, ...rIn.territoryPolicyRules],
    ownerWorkloads: rIn.ownerWorkloads, evidenceIds: [], agentName: 'x', agentVersion: 'x', promptVersion: null, modelName: null,
  }
  const routingSnap: DecisionSnapshot = withRoutingContext
    ? { ...snap, routingContext: { owners: rIn.availableOwners, roundRobinCounter: rIn.routingState.counter, maxOpenLeadsPerRep: rIn.maxOpenLeadsPerRep } }
    : snap
  return {
    q: event({ decision_snapshot: snap, proposed_action: q }),
    r: event({ decision_snapshot: routingSnap, proposed_action: r, actor_id: routingAgent.name, agent_version: routingAgent.version }),
    qAction: q, rAction: r,
  }
}

describe('runGolden', () => {
  it('v1 baseline: agrees everywhere except the v1Disagrees cases', async () => {
    const report = await runGolden(v1Decider)
    const routed = GOLDEN_CASES.filter(c => c.expected.routing).length
    expect(report.results).toHaveLength(GOLDEN_CASES.length)
    expect(report.summary.qualification).toMatchObject({ total: GOLDEN_CASES.length, agreed: GOLDEN_CASES.length - disagreeCount('qualification'), errors: 0 })
    expect(report.summary.routing).toMatchObject({ total: routed, agreed: routed - disagreeCount('routing'), errors: 0 })
    expect(report.summary.injection.rate).toBe(1)
    expect(report.summary.byTag.title_false_positive.agreed).toBe(0)
  })

  it('records decider errors and missing tiers as disagreements, never skips them', async () => {
    let n = 0
    const flaky: Decider = {
      name: 'flaky', version: '0',
      qualify: async input => {
        n++
        if (n % 2) throw new Error('MODEL_TIMEOUT')
        return { type: 'qualify_lead', parameters: { reason_codes: [] }, decisionRiskScore: 0, rawConfidence: 0 }
      },
    }
    const report = await runGolden(flaky)
    expect(report.summary.qualification.agreed).toBe(0)
    expect(report.summary.qualification.errors).toBe(GOLDEN_CASES.length)
    expect(report.summary.routing).toBeNull()
    expect(report.results[0].qualification.error).toBe('MODEL_TIMEOUT')
    expect(report.results[1].qualification.error).toBe('DECIDER_OUTPUT_HAS_NO_TIER')
  })

  it('skips routing (with an error) when qualification failed', async () => {
    const d: Decider = { ...v1Decider, qualify: async () => { throw new Error('boom') } }
    const report = await runGolden(d, [byId('perfect-fit')])
    expect(report.results[0].routing).toMatchObject({ agrees: false, error: 'ROUTING_SKIPPED_QUALIFICATION_FAILED' })
  })
})

describe('replaySnapshots', () => {
  it('v1 replaying its own recorded decisions agrees 100%', async () => {
    const pairs = ['perfect-fit', 'live-review-no-territory', 'catch-all-territory', 'boundary-100-all-at-capacity'].map(id => recordedPair(id))
    const report = await replaySnapshots(v1Decider, pairs.flatMap(p => [p.q, p.r]))
    expect(report.summary.qualification).toMatchObject({ agreed: 4, total: 4 })
    expect(report.summary.routing).toMatchObject({ agreed: 4, total: 4 })
    expect(report.summary.skipped).toEqual({})
  })

  it('scores with the ICP policy stored in the snapshot', async () => {
    const { q } = recordedPair('boundary-100-all-at-capacity') // score 75 → recorded tier_1
    const icp = q.decision_snapshot.policies[0]
    const stricter = { ...icp, conditions: { ...icp.conditions, tier_thresholds: { tier_1: 80, tier_2: 45 } } }
    const ev = { ...q, decision_snapshot: { ...q.decision_snapshot, policies: [stricter] } }
    const report = await replaySnapshots(v1Decider, [ev])
    expect(report.results[0]).toMatchObject({ status: 'replayed', recorded: 'tier_1', actual: 'tier_2', agrees: false })
  })

  it('flags a decider that would have decided differently', async () => {
    const { q, r } = recordedPair('perfect-fit')
    const contrarian: Decider = {
      name: 'contrarian', version: '0',
      qualify: async () => ({ type: 'qualify_lead', parameters: { icp_tier: 'not_icp' }, decisionRiskScore: 0, rawConfidence: 1 }),
      route: async () => ({ type: 'request_human_review', parameters: { reason_codes: ['NO_TERRITORY_MATCH'] }, decisionRiskScore: 0, rawConfidence: 1 }),
    }
    const report = await replaySnapshots(contrarian, [q, r])
    expect(report.results.map(x => x.status === 'replayed' && x.agrees)).toEqual([false, false])
    expect(report.results[1]).toMatchObject({ recorded: { action: 'assign_owner', ownerId: 'rep_b', queue: 'na' }, actual: { action: 'request_human_review' } })
  })

  it('skips with an explicit reason when a snapshot cannot be replayed', async () => {
    const { q, r } = recordedPair('perfect-fit', false)
    const other = { ...q, actor_id: 'outreach-agent' }
    const noDecision = { ...q, proposed_action: null }
    const qualOnly: Decider = { name: 'q', version: '0', qualify: v1Decider.qualify }
    const report = await replaySnapshots(v1Decider, [r, other, noDecision])
    expect(report.summary.skipped).toEqual({ SNAPSHOT_MISSING_ROUTING_CONTEXT: 1, EVENT_NOT_AN_AGENT_PROPOSAL: 1, RECORDED_DECISION_MISSING: 1 })
    expect(report.summary.qualification.total).toBe(0)
    const r2 = recordedPair('perfect-fit').r
    expect((await replaySnapshots(qualOnly, [r2])).summary.skipped).toEqual({ DECIDER_DOES_NOT_ROUTE: 1 })
  })

  it('counts decider errors as disagreements', async () => {
    const { q } = recordedPair('perfect-fit')
    const broken: Decider = { name: 'b', version: '0', qualify: async (): Promise<ProposedAction> => { throw new Error('INVALID_JSON') } }
    const report = await replaySnapshots(broken, [q])
    expect(report.results[0]).toMatchObject({ status: 'error', error: 'INVALID_JSON', recorded: 'tier_1' })
    expect(report.summary.qualification).toMatchObject({ agreed: 0, total: 1, errors: 1 })
  })
})
