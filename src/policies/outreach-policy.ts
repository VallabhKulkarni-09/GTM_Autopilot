/**
 * outreach-policy.ts — the org's "Outreach" settings (policy_rules.rule_type = 'outreach',
 * stored in `actions`): which Apollo sequence each fit tier goes into, and which
 * Apollo mailbox sends the emails.
 *
 * Stored shape (actions):
 *   {
 *     email_account: { id, email } | null,
 *     tiers: {
 *       tier_1: TierSetting | null,   // null = not set up yet
 *       tier_2: TierSetting | null,
 *     }
 *   }
 *   TierSetting = { mode: 'sequence', sequence_id, sequence_name } | { mode: 'manual' }
 *
 * 'manual' is an explicit choice: the assigned rep follows up by hand, no sequence.
 * null means nobody has chosen yet; at runtime that escalates (never a silent skip).
 * Nothing here fills in missing values: invalid or missing config throws.
 */

import type { PolicyRule } from '../domain/db-types.js'

export const OUTREACH_TIERS = ['tier_1', 'tier_2'] as const
export type OutreachTier = typeof OUTREACH_TIERS[number]

export type TierSetting =
  | { mode: 'sequence'; sequence_id: string; sequence_name: string }
  | { mode: 'manual' }

export type OutreachConfig = {
  email_account: { id: string; email: string } | null
  tiers: Record<OutreachTier, TierSetting | null>
}

export const EMPTY_OUTREACH_CONFIG: OutreachConfig = {
  email_account: null,
  tiers: { tier_1: null, tier_2: null },
}

const TIER_LABEL: Record<OutreachTier, string> = { tier_1: 'Great fit', tier_2: 'Good fit' }

export class OutreachConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`OUTREACH_POLICY_INVALID: ${issues.join('; ')}`)
    this.name = 'OutreachConfigError'
  }
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200

/** Validates a stored or submitted config. Collects every problem, in plain language. */
export function parseOutreachConfig(raw: unknown): OutreachConfig {
  const issues: string[] = []
  const obj = (raw ?? {}) as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new OutreachConfigError(['outreach settings are missing'])
  }

  let email_account: OutreachConfig['email_account'] = null
  const ea = obj.email_account
  if (ea !== null && ea !== undefined) {
    const e = ea as Record<string, unknown>
    if (typeof ea !== 'object' || !isNonEmptyString(e.id) || typeof e.email !== 'string') {
      issues.push('the sending mailbox is not valid; pick it again')
    } else {
      email_account = { id: e.id, email: e.email }
    }
  } else if (ea === undefined) {
    issues.push('the sending mailbox setting is missing')
  }

  const tiersRaw = obj.tiers as Record<string, unknown> | undefined
  const tiers = { tier_1: null, tier_2: null } as OutreachConfig['tiers']
  if (typeof tiersRaw !== 'object' || tiersRaw === null || Array.isArray(tiersRaw)) {
    issues.push('the sequence for each fit level is missing')
  } else {
    for (const tier of OUTREACH_TIERS) {
      const t = tiersRaw[tier]
      if (!(tier in tiersRaw)) { issues.push(`the "${TIER_LABEL[tier]}" setting is missing`); continue }
      if (t === null) continue
      const s = t as Record<string, unknown>
      if (typeof t !== 'object' || Array.isArray(t)) {
        issues.push(`the "${TIER_LABEL[tier]}" setting is not valid`)
      } else if (s.mode === 'manual') {
        tiers[tier] = { mode: 'manual' }
      } else if (s.mode === 'sequence' && isNonEmptyString(s.sequence_id) && typeof s.sequence_name === 'string') {
        tiers[tier] = { mode: 'sequence', sequence_id: s.sequence_id, sequence_name: s.sequence_name }
      } else {
        issues.push(`the "${TIER_LABEL[tier]}" sequence is not valid; pick it again`)
      }
    }
  }

  if (issues.length) throw new OutreachConfigError(issues)
  return { email_account, tiers }
}

/** Extra checks for a config an admin is saving (stored configs may be partly set up). */
export function validateForSave(config: OutreachConfig): string[] {
  const usesSequence = OUTREACH_TIERS.some(t => config.tiers[t]?.mode === 'sequence')
  return usesSequence && !config.email_account
    ? ['pick the mailbox Apollo should send from']
    : []
}

/** Picks the active outreach policy. Throws if the workspace has none. */
export function selectOutreachPolicy(rules: PolicyRule[]): { rule: PolicyRule; config: OutreachConfig } {
  const rule = rules
    .filter(r => r.rule_type === 'outreach' && r.is_active)
    .sort((a, b) => a.priority - b.priority)[0]
  if (!rule) {
    throw new Error('OUTREACH_POLICY_MISSING: no active outreach policy for this workspace. Set it on the Outreach page.')
  }
  return { rule, config: parseOutreachConfig(rule.actions) }
}

export type OutreachPlan =
  | { kind: 'enroll'; tier: OutreachTier; sequenceId: string; sequenceName: string; emailAccountId: string }
  | { kind: 'manual'; tier: OutreachTier | null; reason: 'MANUAL_FOLLOW_UP_FOR_TIER' | 'ACTIVE_DEAL_OWNER_FOLLOW_UP' }
  | { kind: 'not_configured'; tier: string | null; code: 'OUTREACH_TIER_NOT_SET' | 'OUTREACH_EMAIL_ACCOUNT_NOT_SET' | 'OUTREACH_TIER_UNKNOWN'; message: string }

/**
 * Decides what first-touch does for a lead. Pure.
 * `tier` is the lead's icp_tier; `activeDeal` is the account-match bypass
 * (existing open deal → the account owner follows up, no cold sequence).
 */
export function planOutreach(config: OutreachConfig, tier: string | null, activeDeal: boolean): OutreachPlan {
  if (activeDeal) return { kind: 'manual', tier: null, reason: 'ACTIVE_DEAL_OWNER_FOLLOW_UP' }
  if (tier !== 'tier_1' && tier !== 'tier_2') {
    return { kind: 'not_configured', tier, code: 'OUTREACH_TIER_UNKNOWN', message: `Lead has no fit level that maps to a sequence (icp_tier=${tier ?? 'null'})` }
  }
  const setting = config.tiers[tier]
  if (!setting) {
    return { kind: 'not_configured', tier, code: 'OUTREACH_TIER_NOT_SET', message: `No sequence chosen for "${TIER_LABEL[tier]}" leads. Set it on the Outreach page.` }
  }
  if (setting.mode === 'manual') return { kind: 'manual', tier, reason: 'MANUAL_FOLLOW_UP_FOR_TIER' }
  if (!config.email_account) {
    return { kind: 'not_configured', tier, code: 'OUTREACH_EMAIL_ACCOUNT_NOT_SET', message: 'No sending mailbox chosen. Set it on the Outreach page.' }
  }
  return { kind: 'enroll', tier, sequenceId: setting.sequence_id, sequenceName: setting.sequence_name, emailAccountId: config.email_account.id }
}
