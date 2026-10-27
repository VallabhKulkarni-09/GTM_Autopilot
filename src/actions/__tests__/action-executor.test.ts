/**
 * action-executor.test.ts
 * Unit tests for executeAction().
 * Mocks: Supabase client, connectors, writeEvent
 * Does NOT mock: business logic in action-executor itself
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeAction } from '../action-executor.js'
import type { ProposedAction, ConnectorRegistry, DecisionSnapshot } from '../types.js'

// ─── Mock Supabase ────────────────────────────────────────────────────────────

let idempotencyExists = false  // flip this to simulate a hit
const mockSingle = vi.fn()

/**
 * Thenable proxy chain. Every method returns another chain.
 * When awaited, resolves with the current mockDbResult.
 * Special case: .single() calls the mockSingle fn.
 */
let mockDbResult: unknown = { data: [], error: null, count: 0 }

function buildChain(): any {
  const chain: any = {
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve(mockDbResult).then(resolve)
    },
    catch(reject: (e: unknown) => unknown) {
      return Promise.resolve(mockDbResult).catch(reject)
    },
    single: mockSingle,
  }
  return new Proxy(chain, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return (..._args: unknown[]) => buildChain()
    },
  })
}

vi.mock('../../db/client.js', () => ({
  getDb: () => ({
    from: (table: string) => ({
      select: (..._args: unknown[]) => {
        // Idempotency check reads event_log (action_execution_succeeded with this key)
        if (table === 'event_log') {
          const count = idempotencyExists ? 1 : 0
          return buildChainWith({ count, data: [], error: null })
        }
        return buildChain()
      },
      update: () => buildChain(),
      insert: () => buildChain(),
    }),
  }),
  _resetDbClient: vi.fn(),
}))

function buildChainWith(result: unknown): any {
  const chain: any = {
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve(result).then(resolve)
    },
    catch(reject: (e: unknown) => unknown) {
      return Promise.resolve(result).catch(reject)
    },
    single: mockSingle,
  }
  return new Proxy(chain, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return (..._args: unknown[]) => buildChainWith(result)
    },
  })
}

// ─── Mock writeEvent ──────────────────────────────────────────────────────────

const mockWriteEvent = vi.fn().mockResolvedValue({ id: 'evt_1' })
vi.mock('../../events/event-log.js', () => ({
  writeEvent: (...args: unknown[]) => mockWriteEvent(...args),
}))


const mockAddJob = vi.fn().mockResolvedValue(undefined)
vi.mock('../../queue/setup.js', () => ({
  addJob: (...args: unknown[]) => mockAddJob(...args),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORG_ID = 'org_1'
const WF_ID = 'wf_1'
const PLAY_ID = 'play_1'
const LEAD_ID = 'lead_1'
const IDEM_KEY = `${ORG_ID}:${WF_ID}:action_1`

const snapshot: DecisionSnapshot = {
  lead: { id: LEAD_ID } as any,
  company: null,
  policies: [],
  ownerWorkloads: {},
  evidenceIds: [],
  agentName: 'test',
  agentVersion: '1.0.0',
  promptVersion: null,
  modelName: null,
}

function makeAction(type: string, parameters: Record<string, unknown> = {}): ProposedAction {
  return {
    actionId: 'action_1',
    type: type as any,
    target: { leadId: LEAD_ID, organizationId: ORG_ID },
    rationale: { reasonCodes: [], evidenceIds: [] },
    decisionRiskScore: 0.0,
    rawConfidence: 1.0,
    parameters,
    idempotencyKey: IDEM_KEY,
    constraints: { requiredPolicyIds: [] },
  }
}

const mockSalesforce = {
  assignLeadOwner: vi.fn().mockResolvedValue(undefined),
  createTask: vi.fn().mockResolvedValue({ Id: 'sf_task_1' }),
}
const mockOutreach = {
  enrollInSequence: vi.fn().mockResolvedValue(undefined),
}
const connectors: ConnectorRegistry = {
  salesforce: mockSalesforce,
  outreach: mockOutreach,
  hubspot: {},
  clearbit: {},
} as any

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('executeAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    idempotencyExists = false
    mockDbResult = { data: [], error: null, count: 0 }
    mockSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })
    mockWriteEvent.mockResolvedValue({ id: 'evt_1' })
  })

  it('qualify_lead: updates lead, emits started + succeeded events', async () => {
    const action = makeAction('qualify_lead', {
      is_icp_fit: true,
      icp_score: 75,
      icp_tier: 'tier_1',
    })

    const result = await executeAction(action, connectors, ORG_ID, WF_ID, PLAY_ID, snapshot)

    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({ is_icp_fit: true, icp_score: 75, icp_tier: 'tier_1' })

    const eventTypes = mockWriteEvent.mock.calls.map((c) => c[0].eventType)
    expect(eventTypes).toContain('action_execution_started')
    expect(eventTypes).toContain('action_execution_succeeded')
    expect(eventTypes).not.toContain('action_execution_failed')
  })

  it('assign_owner: calls SF assignLeadOwner + createTask, updates routing_state', async () => {
    // Mock routing_state lookup for increment
    mockSingle.mockResolvedValueOnce({ data: { id: 'rs_1', counter: 2 }, error: null })

    const action = makeAction('assign_owner', {
      recommended_owner_id: 'sf_owner_1',
      queue_name: 'na_smb',
      sf_lead_id: 'sf_lead_1',
    })

    const result = await executeAction(action, connectors, ORG_ID, WF_ID, PLAY_ID, snapshot)

    expect(result.success).toBe(true)
    expect(result.externalSystem).toBe('salesforce')
    expect(mockSalesforce.assignLeadOwner).toHaveBeenCalledWith('sf_lead_1', 'sf_owner_1', `${IDEM_KEY}:assign`)
    expect(mockSalesforce.createTask).toHaveBeenCalledWith(
      'sf_lead_1',
      // The Task belongs to the assigned rep, not the API "Run As" user.
      expect.objectContaining({ due_date: expect.any(String), ownerId: 'sf_owner_1' }),
      `${IDEM_KEY}:task`
    )
  })

  it('idempotency hit: emits deduplicated event, returns cached result', async () => {
    idempotencyExists = true  // simulate key already exists

    const action = makeAction('qualify_lead', { is_icp_fit: true, icp_score: 80, icp_tier: 'tier_1' })
    const result = await executeAction(action, connectors, ORG_ID, WF_ID, PLAY_ID, snapshot)

    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({ deduplicated: true })
    const eventTypes = mockWriteEvent.mock.calls.map((c) => c[0].eventType)
    expect(eventTypes).toContain('action_execution_deduplicated')
    // Should NOT emit started/succeeded since it was deduplicated
    expect(eventTypes).not.toContain('action_execution_started')
  })

  it('ConnectorError: emits failed event, re-throws', async () => {
    const { ConnectorError } = await import('../types.js')
    mockSalesforce.assignLeadOwner.mockRejectedValueOnce(
      new ConnectorError('salesforce', 'ASSIGN_FAILED', 500, { raw: true }, 'SF assign failed')
    )

    const action = makeAction('assign_owner', {
      recommended_owner_id: 'sf_owner_1',
      queue_name: 'na_smb',
      sf_lead_id: 'sf_lead_1',
    })

    await expect(
      executeAction(action, connectors, ORG_ID, WF_ID, PLAY_ID, snapshot)
    ).rejects.toThrow('SF assign failed')

    const eventTypes = mockWriteEvent.mock.calls.map((c) => c[0].eventType)
    expect(eventTypes).toContain('action_execution_failed')
  })

  it('event_log write happens even when connector throws (try/finally)', async () => {
    mockSalesforce.assignLeadOwner.mockRejectedValueOnce(new Error('Network timeout'))

    const action = makeAction('assign_owner', {
      recommended_owner_id: 'sf_owner_1',
      queue_name: 'na_smb',
      sf_lead_id: 'sf_lead_1',
    })

    try {
      await executeAction(action, connectors, ORG_ID, WF_ID, PLAY_ID, snapshot)
    } catch {
      // expected
    }

    const eventTypes = mockWriteEvent.mock.calls.map((c) => c[0].eventType)
    // started was written before connector call
    expect(eventTypes).toContain('action_execution_started')
    // failed must be written even after throw
    expect(eventTypes).toContain('action_execution_failed')
  })
})

// ─── start_sequence: Apollo ───────────────────────────────────────────────────

describe('executeAction start_sequence (apollo)', () => {
  const apolloSnapshot: DecisionSnapshot = {
    ...snapshot,
    lead: { id: LEAD_ID, email: 'ana@acme.io', first_name: 'Ana', last_name: 'Lee', title: 'VP Sales' } as any,
    company: { name: 'Acme', domain: 'acme.io' } as any,
  }
  const policyRef = { outreach_policy_id: 'pol_out', outreach_policy_version: 3 }
  const enrollParams = {
    provider: 'apollo', plan: 'enroll', tier: 'tier_1', ...policyRef,
    apollo_sequence_id: 'seq_1', apollo_sequence_name: 'Great fit', apollo_email_account_id: 'acct_1',
  }
  const apollo = {
    findContactByEmail:   vi.fn(),
    createContact:        vi.fn(),
    addContactToSequence: vi.fn(),
  }
  const withApollo = { apollo } as unknown as ConnectorRegistry
  const types = () => mockWriteEvent.mock.calls.map(c => c[0].eventType)
  const failed = () => mockWriteEvent.mock.calls.find(c => c[0].eventType === 'action_execution_failed')?.[0]

  beforeEach(() => {
    vi.clearAllMocks()
    idempotencyExists = false
    mockWriteEvent.mockResolvedValue({ id: 'evt_1' })
    apollo.findContactByEmail.mockResolvedValue(null)
    apollo.createContact.mockResolvedValue({ id: 'ct_1', sequenceIds: [] })
    apollo.addContactToSequence.mockResolvedValue({ contactId: 'ct_1', sequenceId: 'seq_1', campaignStatusId: 'ccs_1' })
  })

  it('enroll: creates the contact, adds it to the sequence, succeeds with Apollo IDs', async () => {
    const result = await executeAction(makeAction('start_sequence', enrollParams), withApollo, ORG_ID, WF_ID, PLAY_ID, apolloSnapshot)

    expect(apollo.findContactByEmail).toHaveBeenCalledWith('ana@acme.io')
    expect(apollo.createContact).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@acme.io', firstName: 'Ana', organizationName: 'Acme', websiteUrl: 'https://acme.io' }),
      `${IDEM_KEY}:create_contact`,
    )
    expect(apollo.addContactToSequence).toHaveBeenCalledWith('ct_1', 'seq_1', 'acct_1', `${IDEM_KEY}:add_to_sequence`)
    expect(result).toMatchObject({
      success: true, externalSystem: 'apollo', externalId: 'ct_1',
      output: { enrolled: true, already_enrolled: false, apollo_sequence_id: 'seq_1', campaign_status_id: 'ccs_1', ...policyRef },
    })
    expect(types()).toEqual(['action_execution_started', 'action_execution_succeeded'])
    expect(mockAddJob).not.toHaveBeenCalled()
  })

  it('enroll: existing contact already in the sequence is not added again', async () => {
    apollo.findContactByEmail.mockResolvedValue({ id: 'ct_9', sequenceIds: ['seq_1'] })
    const result = await executeAction(makeAction('start_sequence', enrollParams), withApollo, ORG_ID, WF_ID, PLAY_ID, apolloSnapshot)
    expect(apollo.createContact).not.toHaveBeenCalled()
    expect(apollo.addContactToSequence).not.toHaveBeenCalled()
    expect(result.output).toMatchObject({ enrolled: true, already_enrolled: true, apollo_contact_id: 'ct_9' })
  })

  it('Apollo not connected → escalates NO_SEP_CONNECTOR_AVAILABLE, failed event', async () => {
    await expect(executeAction(makeAction('start_sequence', enrollParams), {} as ConnectorRegistry, ORG_ID, WF_ID, PLAY_ID, apolloSnapshot))
      .rejects.toMatchObject({ code: 'NO_SEP_CONNECTOR_AVAILABLE' })
    expect(failed()).toMatchObject({ errorCode: 'NO_SEP_CONNECTOR_AVAILABLE' })
    expect(mockAddJob).toHaveBeenCalledWith('escalate-play', { playId: PLAY_ID, organizationId: ORG_ID, reason: 'NO_SEP_CONNECTOR_AVAILABLE' }, { priority: 2 })
  })

  it('not_configured → escalates with the specific code, Apollo never called', async () => {
    const params = { provider: 'apollo', plan: 'not_configured', tier: 'tier_2', ...policyRef, reason_code: 'OUTREACH_TIER_NOT_SET', reason_message: 'No sequence chosen' }
    await expect(executeAction(makeAction('start_sequence', params), withApollo, ORG_ID, WF_ID, PLAY_ID, apolloSnapshot))
      .rejects.toMatchObject({ code: 'OUTREACH_TIER_NOT_SET' })
    expect(failed()).toMatchObject({ errorCode: 'OUTREACH_TIER_NOT_SET' })
    expect(apollo.findContactByEmail).not.toHaveBeenCalled()
    expect(mockAddJob).toHaveBeenCalledOnce()
  })

  it('manual → succeeded with enrolled=false, no Apollo call, no escalation', async () => {
    const params = { provider: 'apollo', plan: 'manual', tier: 'tier_2', ...policyRef, reason_code: 'MANUAL_FOLLOW_UP_FOR_TIER' }
    const result = await executeAction(makeAction('start_sequence', params), withApollo, ORG_ID, WF_ID, PLAY_ID, apolloSnapshot)
    expect(result.output).toMatchObject({ enrolled: false, follow_up: 'manual', reason_code: 'MANUAL_FOLLOW_UP_FOR_TIER' })
    expect(apollo.findContactByEmail).not.toHaveBeenCalled()
    expect(mockAddJob).not.toHaveBeenCalled()
    expect(types()).toEqual(['action_execution_started', 'action_execution_succeeded'])
  })

  it('Apollo refuses the contact (AP_SEQUENCE_FAILED) → failed event with code, escalated, rethrown', async () => {
    const { ConnectorError } = await import('../../connectors/base.js')
    apollo.addContactToSequence.mockRejectedValue(new ConnectorError('apollo', 'AP_SEQUENCE_FAILED', 200, { skipped_contact_ids: { ct_1: 'x' } }, 'skipped'))
    await expect(executeAction(makeAction('start_sequence', enrollParams), withApollo, ORG_ID, WF_ID, PLAY_ID, apolloSnapshot))
      .rejects.toMatchObject({ code: 'AP_SEQUENCE_FAILED' })
    expect(failed()).toMatchObject({ errorCode: 'AP_SEQUENCE_FAILED', errorRaw: { skipped_contact_ids: { ct_1: 'x' } } })
    expect(mockAddJob).toHaveBeenCalledOnce()
  })

  it('retryable Apollo error (rate limit) → failed event, rethrown, not escalated', async () => {
    const { ConnectorError } = await import('../../connectors/base.js')
    apollo.findContactByEmail.mockRejectedValue(new ConnectorError('apollo', 'AP_RATE_LIMITED', 429, 'slow down', 'rate limited'))
    await expect(executeAction(makeAction('start_sequence', enrollParams), withApollo, ORG_ID, WF_ID, PLAY_ID, apolloSnapshot))
      .rejects.toMatchObject({ code: 'AP_RATE_LIMITED' })
    expect(failed()).toMatchObject({ errorCode: 'AP_RATE_LIMITED' })
    expect(mockAddJob).not.toHaveBeenCalled()
  })

  it('already succeeded (idempotency hit) → deduplicated, Apollo never called', async () => {
    idempotencyExists = true
    const result = await executeAction(makeAction('start_sequence', enrollParams), withApollo, ORG_ID, WF_ID, PLAY_ID, apolloSnapshot)
    expect(result.output).toMatchObject({ deduplicated: true })
    expect(apollo.findContactByEmail).not.toHaveBeenCalled()
  })
})
