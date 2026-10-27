/**
 * outcome-detection-poller.test.ts
 * Tests for the outcome detection poller job logic.
 *
 * Uses vi.mock with inline factory functions (no outer variable references,
 * since vi.mock is hoisted before variable initialization).
 * Mocks are accessed via vi.mocked() after import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../../src/db/client.js',               () => ({ getDb: vi.fn() }))
vi.mock('../../../src/events/event-log.js',         () => ({ writeEvent: vi.fn() }))
vi.mock('../../../src/connectors/salesforce/events.js', () => ({
  queryMeetingEvents:    vi.fn(),
  queryLeadStatus:       vi.fn(),
  queryOpportunityStage: vi.fn(),
  queryCustomCheckbox:   vi.fn(),
}))
vi.mock('../../../src/policies/outcome-detection.js', () => ({
  loadOutcomeDetectionConfig: vi.fn(),
  OutcomeDetectionConfigMissingError: class OutcomeDetectionConfigMissingError extends Error {
    constructor(orgId: string) { super(`No outcome_detection policy for ${orgId}`) }
  },
}))
vi.mock('../../../src/connectors/salesforce/salesforce.connector.js', () => ({
  SalesforceConnector: vi.fn(),
}))
// Per-org connectors come from the factory (encrypted workspace credentials).
const { mockSalesforce } = vi.hoisted(() => ({ mockSalesforce: vi.fn() }))
vi.mock('../../../src/connectors/factory.js', () => ({
  getConnectors: () => ({ salesforce: () => mockSalesforce() }),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { getDb }             from '../../../src/db/client.js'
import { writeEvent }        from '../../../src/events/event-log.js'
import * as SfEvents         from '../../../src/connectors/salesforce/events.js'
import * as OutcomePolicy    from '../../../src/policies/outcome-detection.js'
import { ConnectorError }    from '../../../src/connectors/base.js'
import { runOutcomeDetectionPoller } from '../../../src/queue/jobs/outcome-detection-poller.js'

const mockGetDb             = vi.mocked(getDb)
const mockWriteEvent        = vi.mocked(writeEvent)
const mockQueryMeeting      = vi.mocked(SfEvents.queryMeetingEvents)
const mockQueryLeadStatus   = vi.mocked(SfEvents.queryLeadStatus)
const mockLoadConfig        = vi.mocked(OutcomePolicy.loadOutcomeDetectionConfig)

// ── Constants ─────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-0000-0000-000000000001'

const BASE_CONFIG = {
  primaryMeetingTypes:                ['Meeting'],
  attributionWindowDays:              14,
  supportiveLeadStatuses:             ['Meeting Booked'],
  supportiveCheckboxField:            null as string | null,
  supportiveOpportunityStageKeywords: [] as string[],
}

const PLAY = {
  id:                      'play-1',
  lead_id:                 'lead-1',
  created_at:              new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  outcome_status:          'no_outcome_yet',
  attribution_window_days: 14,
  status:                  'running',
}

const SF_EVENT = {
  Id:            'sf-evt-001',
  WhoId:         'sf-lead-001',
  Type:          'Meeting',
  Subject:       'Discovery',
  StartDateTime: new Date().toISOString(),
  EndDateTime:   null as string | null,
  ActivityDate:  null as string | null,
  CreatedDate:   new Date().toISOString(),
}

// ── DB mock helpers ───────────────────────────────────────────────────────────

/** Returns a thenable chain that resolves to result when awaited */
function awaitableChain(result: { data: unknown; error: unknown }) {
  const prom = Promise.resolve(result)
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    eq:     vi.fn().mockReturnThis(),
    in:     vi.fn().mockReturnThis(),
    order:  vi.fn().mockReturnThis(),
    limit:  vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
    insert: vi.fn().mockResolvedValue({ data: {}, error: null }),
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) }),
    then:   prom.then.bind(prom),
  }
  return chain
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  mockSalesforce.mockResolvedValue({ connected: true })

  mockLoadConfig.mockResolvedValue(BASE_CONFIG)
  mockWriteEvent.mockResolvedValue({ id: 'event-1' })
  mockQueryMeeting.mockResolvedValue([])
  mockQueryLeadStatus.mockResolvedValue(null)
  vi.mocked(SfEvents.queryOpportunityStage).mockResolvedValue(null)
  vi.mocked(SfEvents.queryCustomCheckbox).mockResolvedValue(null)
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runOutcomeDetectionPoller — guards', () => {
  it('skips org when no outcome_detection policy configured', async () => {
    const { OutcomeDetectionConfigMissingError } = await import('../../../src/policies/outcome-detection.js')
    mockLoadConfig.mockRejectedValue(new (OutcomeDetectionConfigMissingError as any)(ORG_ID))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(runOutcomeDetectionPoller([ORG_ID])).resolves.toBeUndefined()
    expect(mockQueryMeeting).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('skips org when Salesforce is not connected for the workspace', async () => {
    mockSalesforce.mockResolvedValue(null)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(runOutcomeDetectionPoller([ORG_ID])).resolves.toBeUndefined()
    expect(mockQueryMeeting).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('skips org (no throw) when Salesforce credentials fail to connect', async () => {
    mockSalesforce.mockRejectedValue(new Error('invalid_client'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(runOutcomeDetectionPoller([ORG_ID])).resolves.toBeUndefined()
    expect(mockQueryMeeting).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('runOutcomeDetectionPoller — idempotency', () => {
  it('re-polling same SF Event → no duplicate outcome_signal, no duplicate event', async () => {
    const playsChain    = awaitableChain({ data: [PLAY], error: null })
    const identityChain = awaitableChain({ data: { external_id: 'sf-lead-001' }, error: null })
    const signalExists  = awaitableChain({ data: { id: 'existing' }, error: null })

    let n = 0
    mockGetDb.mockReturnValue({
      from: vi.fn(() => {
        n++
        if (n === 1) return playsChain
        if (n === 2) return identityChain
        return signalExists   // signal already in DB
      }),
    } as any)

    mockQueryMeeting.mockResolvedValue([SF_EVENT])

    await runOutcomeDetectionPoller([ORG_ID])

    // signal.insert must NOT have been called
    expect(signalExists.insert).not.toHaveBeenCalled()
    expect(mockWriteEvent).not.toHaveBeenCalled()
  })
})

describe('runOutcomeDetectionPoller — first primary signal', () => {
  it('first primary signal → inserts outcome_signal + writes outcome_detected event', async () => {
    // Actual DB call order in handlePrimarySignals:
    //  1. play_instance (plays batch)
    //  2. external_identity (identity lookup)
    //  3. play_instance (fresh play fetch)
    //  4. outcome_signal (idempotency check → not found)
    //  5. outcome_signal (insert)
    //  6. play_instance (update)

    const insertMock    = vi.fn().mockResolvedValue({ data: {}, error: null })
    const signalInsert  = awaitableChain({ data: {}, error: null })
    signalInsert.insert = insertMock

    const updateMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) }),
    })

    let n = 0
    mockGetDb.mockReturnValue({
      from: vi.fn(() => {
        n++
        if (n === 1) return awaitableChain({ data: [PLAY], error: null })   // plays batch
        if (n === 2) return awaitableChain({ data: { external_id: 'sf-lead-001' }, error: null }) // identity
        if (n === 3) return awaitableChain({ data: { outcome_status: 'no_outcome_yet', meetings_count_in_window: 0 }, error: null }) // fresh play
        if (n === 4) return awaitableChain({ data: null, error: { code: 'PGRST116' } }) // signal check → not found
        if (n === 5) return signalInsert  // signal insert
        // n === 6: play_instance update
        return { ...awaitableChain({ data: {}, error: null }), update: updateMock }
      }),
    } as any)

    mockQueryMeeting.mockResolvedValue([SF_EVENT])

    await runOutcomeDetectionPoller([ORG_ID])

    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal_type: 'sf_event_meeting', confidence: 'primary' })
    )
    expect(mockWriteEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'outcome_detected', organizationId: ORG_ID })
    )
  })
})

describe('runOutcomeDetectionPoller — late meeting', () => {
  it('primary signal after no_meeting cutoff → late_meeting_detected event, no outcome_detected', async () => {
    const pastPlay  = { ...PLAY, outcome_status: 'no_meeting' }
    const notFound  = awaitableChain({ data: null, error: { code: 'PGRST116' } })
    const freshPlay = awaitableChain({ data: { outcome_status: 'no_meeting', meetings_count_in_window: 0 }, error: null })

    let n = 0
    mockGetDb.mockReturnValue({
      from: vi.fn(() => {
        n++
        if (n === 1) return awaitableChain({ data: [pastPlay], error: null })
        if (n === 2) return awaitableChain({ data: { external_id: 'sf-lead-001' }, error: null })
        if (n === 3) return notFound
        if (n === 4) return notFound
        if (n === 5) return freshPlay
        return awaitableChain({ data: {}, error: null })
      }),
    } as any)

    mockQueryMeeting.mockResolvedValue([SF_EVENT])

    await runOutcomeDetectionPoller([ORG_ID])

    expect(mockWriteEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'late_meeting_detected' })
    )
    expect(mockWriteEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'outcome_detected' })
    )
  })
})

describe('runOutcomeDetectionPoller — SF permission error', () => {
  it('ConnectorError on SF Event query → error logged, job resolves without throwing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    let n = 0
    mockGetDb.mockReturnValue({
      from: vi.fn(() => {
        n++
        if (n === 1) return awaitableChain({ data: [PLAY], error: null })
        return awaitableChain({ data: { external_id: 'sf-lead-001' }, error: null })
      }),
    } as any)

    mockQueryMeeting.mockRejectedValue(
      new ConnectorError('salesforce', 'SF_EVENT_OBJECT_NOT_ACCESSIBLE', 400, 'INVALID_TYPE', 'Event object not accessible')
    )

    await expect(runOutcomeDetectionPoller([ORG_ID])).resolves.toBeUndefined()

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('SF Event query failed')
    )
    consoleSpy.mockRestore()
  })
})

describe('runOutcomeDetectionPoller — supportive signals', () => {
  it('supportive lead status → outcome_signal(confidence=supportive), outcome_status unchanged', async () => {
    mockLoadConfig.mockResolvedValue({ ...BASE_CONFIG, supportiveLeadStatuses: ['Meeting Booked'] })
    mockQueryMeeting.mockResolvedValue([])  // no primary
    mockQueryLeadStatus.mockResolvedValue('Meeting Booked')  // supportive hit

    const notFound = awaitableChain({ data: null, error: { code: 'PGRST116' } })

    let n = 0
    mockGetDb.mockReturnValue({
      from: vi.fn(() => {
        n++
        if (n === 1) return awaitableChain({ data: [PLAY], error: null })
        if (n === 2) return awaitableChain({ data: { external_id: 'sf-lead-001' }, error: null })
        return notFound  // signal dedup check + insert
      }),
    } as any)

    await runOutcomeDetectionPoller([ORG_ID])

    expect(notFound.insert).toHaveBeenCalledWith(
      expect.objectContaining({ signal_type: 'lead_status', confidence: 'supportive' })
    )
    // No outcome_detected event — supportive never flips outcome_status
    expect(mockWriteEvent).not.toHaveBeenCalled()
  })
})
