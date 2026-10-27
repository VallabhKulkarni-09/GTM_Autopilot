import { describe, it, expect } from 'vitest'
import {
  parseOutreachConfig, validateForSave, selectOutreachPolicy, planOutreach,
  OutreachConfigError, EMPTY_OUTREACH_CONFIG, type OutreachConfig,
} from '../../../src/policies/outreach-policy.js'
import { buildStartSequenceParams } from '../../../src/workflows/inbound-lead/nodes/first-touch.js'
import { DEFAULT_POLICIES } from '../../../src/policies/default-policies.js'
import type { PolicyRule } from '../../../src/domain/db-types.js'

const FULL: OutreachConfig = {
  email_account: { id: 'acct_1', email: 'sdr@acme.io' },
  tiers: {
    tier_1: { mode: 'sequence', sequence_id: 'seq_1', sequence_name: 'Great fit' },
    tier_2: { mode: 'manual' },
  },
}

const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({
  id: 'pol_out', organization_id: 'org', rule_type: 'outreach', name: 'Outreach', description: null,
  version: 2, is_active: true, priority: 50, conditions: {}, actions: FULL as any,
  ...over,
} as PolicyRule)

describe('parseOutreachConfig', () => {
  it('accepts a full config and the seeded empty config', () => {
    expect(parseOutreachConfig(FULL)).toEqual(FULL)
    expect(parseOutreachConfig(EMPTY_OUTREACH_CONFIG)).toEqual(EMPTY_OUTREACH_CONFIG)
  })

  it('drops unknown keys instead of storing them', () => {
    const parsed = parseOutreachConfig({ ...FULL, extra: 1, tiers: { ...FULL.tiers, tier_2: { mode: 'manual', junk: true } } })
    expect(parsed).toEqual(FULL)
  })

  it('collects every problem in plain language and never fills defaults', () => {
    try {
      parseOutreachConfig({ email_account: { id: '' }, tiers: { tier_1: { mode: 'sequence' } } })
      throw new Error('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(OutreachConfigError)
      expect((e as OutreachConfigError).issues).toEqual([
        'the sending mailbox is not valid; pick it again',
        'the "Great fit" sequence is not valid; pick it again',
        'the "Good fit" setting is missing',
      ])
    }
    expect(() => parseOutreachConfig(null)).toThrow('OUTREACH_POLICY_INVALID')
    expect(() => parseOutreachConfig({ tiers: { tier_1: null, tier_2: null } })).toThrow('sending mailbox setting is missing')
  })
})

describe('validateForSave', () => {
  it('requires a mailbox when any fit level uses a sequence', () => {
    expect(validateForSave(FULL)).toEqual([])
    expect(validateForSave({ ...FULL, email_account: null })).toEqual(['pick the mailbox Apollo should send from'])
    expect(validateForSave({ email_account: null, tiers: { tier_1: { mode: 'manual' }, tier_2: null } })).toEqual([])
  })
})

describe('selectOutreachPolicy', () => {
  it('picks the active outreach rule with the lowest priority number', () => {
    const other = rule({ id: 'pol_2', priority: 10, actions: { ...FULL, tiers: { tier_1: null, tier_2: null } } as any })
    const { rule: r } = selectOutreachPolicy([rule(), other, rule({ id: 'off', priority: 1, is_active: false })])
    expect(r.id).toBe('pol_2')
  })
  it('throws OUTREACH_POLICY_MISSING when there is none', () => {
    expect(() => selectOutreachPolicy([rule({ rule_type: 'routing' as any })])).toThrow('OUTREACH_POLICY_MISSING')
  })
  it('throws OUTREACH_POLICY_INVALID for a corrupt stored row', () => {
    expect(() => selectOutreachPolicy([rule({ actions: { tiers: 'x' } as any })])).toThrow('OUTREACH_POLICY_INVALID')
  })
})

describe('planOutreach', () => {
  it('Great fit → enroll in its sequence from the chosen mailbox', () => {
    expect(planOutreach(FULL, 'tier_1', false)).toEqual({ kind: 'enroll', tier: 'tier_1', sequenceId: 'seq_1', sequenceName: 'Great fit', emailAccountId: 'acct_1' })
  })
  it('Good fit set to manual → manual follow-up', () => {
    expect(planOutreach(FULL, 'tier_2', false)).toEqual({ kind: 'manual', tier: 'tier_2', reason: 'MANUAL_FOLLOW_UP_FOR_TIER' })
  })
  it('active deal → owner follows up, no cold sequence', () => {
    expect(planOutreach(FULL, null, true)).toMatchObject({ kind: 'manual', reason: 'ACTIVE_DEAL_OWNER_FOLLOW_UP' })
  })
  it('unset tier, missing mailbox, unknown tier → not_configured with a specific code', () => {
    expect(planOutreach(EMPTY_OUTREACH_CONFIG, 'tier_1', false)).toMatchObject({ kind: 'not_configured', code: 'OUTREACH_TIER_NOT_SET' })
    expect(planOutreach({ ...FULL, email_account: null }, 'tier_1', false)).toMatchObject({ kind: 'not_configured', code: 'OUTREACH_EMAIL_ACCOUNT_NOT_SET' })
    expect(planOutreach(FULL, 'not_icp', false)).toMatchObject({ kind: 'not_configured', code: 'OUTREACH_TIER_UNKNOWN' })
    expect(planOutreach(FULL, null, false)).toMatchObject({ kind: 'not_configured', code: 'OUTREACH_TIER_UNKNOWN' })
  })
})

describe('buildStartSequenceParams', () => {
  const ref = { id: 'pol_out', version: 2 }
  it('enroll carries the Apollo IDs and the policy id/version', () => {
    expect(buildStartSequenceParams(planOutreach(FULL, 'tier_1', false), ref)).toEqual({
      provider: 'apollo', plan: 'enroll', tier: 'tier_1', outreach_policy_id: 'pol_out', outreach_policy_version: 2,
      apollo_sequence_id: 'seq_1', apollo_sequence_name: 'Great fit', apollo_email_account_id: 'acct_1',
    })
  })
  it('missing policy → not_configured with null policy ref', () => {
    expect(buildStartSequenceParams({ kind: 'not_configured', tier: 'tier_1', code: 'OUTREACH_POLICY_MISSING', message: 'm' }, null)).toMatchObject({
      plan: 'not_configured', reason_code: 'OUTREACH_POLICY_MISSING', outreach_policy_id: null,
    })
  })
})

describe('default policies', () => {
  it('seed an explicitly-unset outreach policy', () => {
    const seed = DEFAULT_POLICIES.find(p => p.rule_type === 'outreach')
    expect(seed?.actions).toEqual({ email_account: null, tiers: { tier_1: null, tier_2: null } })
    expect(parseOutreachConfig(seed?.actions)).toEqual(EMPTY_OUTREACH_CONFIG)
  })
})
