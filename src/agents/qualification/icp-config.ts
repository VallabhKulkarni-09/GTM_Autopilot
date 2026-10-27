/**
 * icp-config.ts — the shape of an organization's "ideal customer" policy
 * (policy_rules.rule_type = 'icp_filter', stored in `conditions`).
 *
 * parseIcpConfig() is the only way to turn stored/user JSON into an IcpConfig.
 * It never fills in missing values: anything absent or invalid throws IcpConfigError.
 */

import type { PolicyRule } from '../../domain/db-types.js'

export type IcpWeights = {
  company_size: number        // employee count within [employee_min, employee_max]
  company_size_near: number   // employee count within [employee_near_min, employee_min)
  company_size_large: number  // employee count above employee_max
  industry: number
  country: number
  intent: number              // form/source matches an intent keyword
  title: number               // job title matches a title keyword
}

export type IcpConfig = {
  industries: string[]        // lowercase, matched as substrings of company.industry
  countries: string[]         // ISO-3166 alpha-2, uppercase
  employee_floor: number      // below this → never a fit
  employee_near_min: number
  employee_min: number
  employee_max: number
  title_keywords: string[]    // lowercase substrings of lead.title
  intent_keywords: string[]   // lowercase substrings of lead.source
  block_free_email: boolean   // gmail.com etc. → never a fit
  weights: IcpWeights
  tier_thresholds: { tier_1: number; tier_2: number }
}

export class IcpConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid ideal customer settings: ${issues.join('; ')}`)
    this.name = 'IcpConfigError'
  }
}

/** Starting values for a new workspace — identical to the formerly hard-coded rules. */
export const DEFAULT_ICP_CONFIG: IcpConfig = {
  industries: ['saas', 'software', 'technology'],
  countries: ['US', 'CA', 'GB', 'DE', 'AU', 'NL'],
  employee_floor: 10,
  employee_near_min: 50,
  employee_min: 100,
  employee_max: 1000,
  title_keywords: ['vp', 'vice president', 'director', 'head', 'chief', 'cto', 'ceo', 'coo', 'cfo', 'founder'],
  intent_keywords: ['demo', 'trial'],
  block_free_email: true,
  weights: { company_size: 30, company_size_near: 15, company_size_large: 20, industry: 25, country: 20, intent: 15, title: 10 },
  tier_thresholds: { tier_1: 70, tier_2: 45 },
}

const WEIGHT_KEYS: (keyof IcpWeights)[] = ['company_size', 'company_size_near', 'company_size_large', 'industry', 'country', 'intent', 'title']
const MAX_LIST = 200
const MAX_ITEM_LEN = 100

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function list(raw: Record<string, unknown>, key: string, issues: string[], transform: (s: string) => string): string[] {
  const v = raw[key]
  if (!Array.isArray(v)) { issues.push(`${key} must be a list`); return [] }
  if (v.length > MAX_LIST) issues.push(`${key} can have at most ${MAX_LIST} entries`)
  const out = new Set<string>()
  for (const item of v) {
    if (typeof item !== 'string' || !item.trim()) { issues.push(`${key} entries must be non-empty text`); continue }
    if (item.length > MAX_ITEM_LEN) { issues.push(`${key} entries must be at most ${MAX_ITEM_LEN} characters`); continue }
    out.add(transform(item.trim()))
  }
  return [...out]
}

function int(raw: Record<string, unknown>, key: string, issues: string[], max: number, label = key): number {
  const v = raw[key]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
    issues.push(`${label} must be a whole number between 0 and ${max}`)
    return 0
  }
  return v
}

export function parseIcpConfig(raw: unknown): IcpConfig {
  const issues: string[] = []
  if (!isObj(raw)) throw new IcpConfigError(['settings must be an object'])

  const industries = list(raw, 'industries', issues, s => s.toLowerCase())
  const countries = list(raw, 'countries', issues, s => s.toUpperCase())
  for (const c of countries) if (!/^[A-Z]{2}$/.test(c)) issues.push(`country "${c}" must be a 2-letter code`)
  const title_keywords = list(raw, 'title_keywords', issues, s => s.toLowerCase())
  const intent_keywords = list(raw, 'intent_keywords', issues, s => s.toLowerCase())

  const MAX_EMP = 10_000_000
  const employee_floor = int(raw, 'employee_floor', issues, MAX_EMP)
  const employee_near_min = int(raw, 'employee_near_min', issues, MAX_EMP)
  const employee_min = int(raw, 'employee_min', issues, MAX_EMP)
  const employee_max = int(raw, 'employee_max', issues, MAX_EMP)
  if (!(employee_floor <= employee_near_min && employee_near_min <= employee_min && employee_min <= employee_max)) {
    issues.push('company sizes must be in order: smallest allowed ≤ partial fit from ≤ ideal from ≤ ideal up to')
  }

  if (typeof raw.block_free_email !== 'boolean') issues.push('block_free_email must be true or false')

  const weights = {} as IcpWeights
  if (!isObj(raw.weights)) issues.push('weights must be an object')
  else for (const k of WEIGHT_KEYS) weights[k] = int(raw.weights, k, issues, 100, `weights.${k}`)

  let tier_1 = 0, tier_2 = 0
  if (!isObj(raw.tier_thresholds)) issues.push('tier_thresholds must be an object')
  else {
    tier_1 = int(raw.tier_thresholds, 'tier_1', issues, 100, 'tier_thresholds.tier_1')
    tier_2 = int(raw.tier_thresholds, 'tier_2', issues, 100, 'tier_thresholds.tier_2')
    if (tier_2 > tier_1) issues.push('the "Good fit" score cannot be higher than the "Great fit" score')
  }

  if (issues.length) throw new IcpConfigError(issues)
  return {
    industries, countries, employee_floor, employee_near_min, employee_min, employee_max,
    title_keywords, intent_keywords, block_free_email: raw.block_free_email as boolean,
    weights, tier_thresholds: { tier_1, tier_2 },
  }
}

/**
 * Picks the org's ICP policy from a list of policy rows. Throws if there is none —
 * qualification must never fall back to built-in values.
 */
export function selectIcpPolicy(rules: PolicyRule[]): { rule: PolicyRule; config: IcpConfig } {
  const active = rules
    .filter(r => r.rule_type === 'icp_filter' && r.is_active)
    .sort((a, b) => a.priority - b.priority)
  if (active.length === 0) {
    throw new Error('ICP_POLICY_MISSING: no active ideal customer policy for this workspace. Set it up on the Ideal customer page.')
  }
  const rule = active[0]
  return { rule, config: parseIcpConfig(rule.conditions) }
}
