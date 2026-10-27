/**
 * Regressions found in the first live HubSpot → Salesforce run (2026-10-27).
 */
import { describe, it, expect, vi } from 'vitest'

const { executeAction } = vi.hoisted(() => ({ executeAction: vi.fn() }))
vi.mock('../../src/actions/executor.js', () => ({ executeAction }))
vi.mock('../../src/actions/validator.js', () => ({ validateAction: vi.fn(async () => ({ approved: true, requiresHumanApproval: false })) }))
vi.mock('../../src/events/event-log.js', () => ({ writeEvent: vi.fn() }))
vi.mock('../../src/connectors/factory.js', () => ({ getConnectors: () => ({ apollo: async () => null }) }))
vi.mock('../../src/evidence/context-builder.js', () => ({
  buildDecisionSnapshot: vi.fn(async () => ({ lead: { icp_tier: 'tier_2' }, policies: [], evidenceIds: [] })),
}))
vi.mock('../../src/policies/outreach-policy.js', () => ({
  selectOutreachPolicy: () => ({ rule: { id: 'p', version: 1 }, config: {} }),
  planOutreach: () => ({ kind: 'not_configured', tier: 'tier_2', code: 'OUTREACH_TIER_NOT_SET', message: 'No sequence chosen' }),
}))

const { firstTouch } = await import('../../src/workflows/inbound-lead/nodes/first-touch.js')
const { SalesforceConnector } = await import('../../src/connectors/salesforce/salesforce.connector.js')

const state = { organizationId: 'org-a', workflowRunId: '2', playInstanceId: 'play', leadId: 'lead' } as any

describe('first-touch: missing outreach setting', () => {
  it('ends the step without failing the job (a retry would repeat Salesforce calls)', async () => {
    executeAction.mockRejectedValueOnce(Object.assign(new Error('OUTREACH_TIER_NOT_SET: No sequence chosen'), { code: 'OUTREACH_TIER_NOT_SET', retryable: false }))
    await expect(firstTouch(state)).resolves.toEqual({ currentStep: 'first_touch' })
  })

  it('still fails the job for retryable errors (e.g. Apollo outage)', async () => {
    executeAction.mockRejectedValueOnce(Object.assign(new Error('AP_RATE_LIMITED'), { code: 'AP_RATE_LIMITED', statusCode: 429 }))
    await expect(firstTouch(state)).rejects.toThrow('AP_RATE_LIMITED')
  })
})

describe('Salesforce getUsers: only people who can own leads', () => {
  it('filters out system and integration users', async () => {
    const sf = new SalesforceConnector()
    const query = vi.spyOn(sf as any, 'query').mockResolvedValue([])
    await sf.getUsers({ isActive: true })
    const soql = decodeURIComponent(String(query.mock.calls[0][0])).replace(/\+/g, ' ')
    expect(soql).toContain("IsActive = true")
    expect(soql).toContain("UserType = 'Standard'")
    expect(soql).toContain("Profile.UserLicense.Name = 'Salesforce'")
  })
})
