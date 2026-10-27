/**
 * outcome-detection.test.ts
 * Tests for the outcome_detection policy config loader.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadOutcomeDetectionConfig, OutcomeDetectionConfigMissingError } from '../../../src/policies/outcome-detection.js'

// ── Mock Supabase client ──────────────────────────────────────────────────────

const mockSingle = vi.fn()
const mockLimit  = vi.fn(() => ({ single: mockSingle }))
const mockOrder  = vi.fn(() => ({ limit: mockLimit }))
const mockEq3    = vi.fn(() => ({ order: mockOrder }))
const mockEq2    = vi.fn(() => ({ eq: mockEq3 }))
const mockEq1    = vi.fn(() => ({ eq: mockEq2 }))
const mockSelect = vi.fn(() => ({ eq: mockEq1 }))
const mockFrom   = vi.fn(() => ({ select: mockSelect }))

vi.mock('../../../src/db/client.js', () => ({
  getDb: () => ({ from: mockFrom }),
}))

const ORG_A = '00000000-0000-0000-0000-000000000001'
const ORG_B = '00000000-0000-0000-0000-000000000002'

const validConditions = {
  primary_meeting_types:                  ['Meeting', 'Discovery Call'],
  attribution_window_days:                14,
  supportive_lead_statuses:               ['Meeting Booked'],
  supportive_checkbox_field:              'Meeting_Booked__c',
  supportive_opportunity_stage_keywords:  ['Discovery'],
}

describe('loadOutcomeDetectionConfig', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns parsed config when active outcome_detection policy exists', async () => {
    mockSingle.mockResolvedValueOnce({ data: { conditions: validConditions }, error: null })

    const config = await loadOutcomeDetectionConfig(ORG_A)

    expect(config.primaryMeetingTypes).toEqual(['Meeting', 'Discovery Call'])
    expect(config.attributionWindowDays).toBe(14)
    expect(config.supportiveLeadStatuses).toEqual(['Meeting Booked'])
    expect(config.supportiveCheckboxField).toBe('Meeting_Booked__c')
    expect(config.supportiveOpportunityStageKeywords).toEqual(['Discovery'])
  })

  it('throws OutcomeDetectionConfigMissingError when no policy row found', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'No rows', code: 'PGRST116' } })

    await expect(loadOutcomeDetectionConfig(ORG_A))
      .rejects.toThrowError(OutcomeDetectionConfigMissingError)
  })

  it('throws OutcomeDetectionConfigMissingError — never silently returns defaults', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'Not found' } })

    const err = await loadOutcomeDetectionConfig(ORG_A).catch(e => e)
    expect(err).toBeInstanceOf(OutcomeDetectionConfigMissingError)
    expect(err.name).toBe('OutcomeDetectionConfigMissingError')
    // Must contain org ID in message to help with debugging
    expect(err.message).toContain(ORG_A)
  })

  it('cross-org isolation: separate DB calls per org, no leakage', async () => {
    const conditionsA = { ...validConditions, attribution_window_days: 7 }
    const conditionsB = { ...validConditions, attribution_window_days: 30 }

    mockSingle
      .mockResolvedValueOnce({ data: { conditions: conditionsA }, error: null })
      .mockResolvedValueOnce({ data: { conditions: conditionsB }, error: null })

    const [configA, configB] = await Promise.all([
      loadOutcomeDetectionConfig(ORG_A),
      loadOutcomeDetectionConfig(ORG_B),
    ])

    // Each org gets its own config — no cross-contamination
    expect(configA.attributionWindowDays).toBe(7)
    expect(configB.attributionWindowDays).toBe(30)
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('supportiveCheckboxField is null when not configured', async () => {
    const conditions = { ...validConditions, supportive_checkbox_field: null }
    mockSingle.mockResolvedValueOnce({ data: { conditions }, error: null })

    const config = await loadOutcomeDetectionConfig(ORG_A)
    expect(config.supportiveCheckboxField).toBeNull()
  })
})
