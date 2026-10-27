/**
 * rules.ts — QualificationAgent v1 ICP scoring formula.
 * ZERO LLM calls. ZERO external API calls. Pure deterministic function of (lead, company, config).
 * All thresholds, keyword lists and weights come from the org's `icp_filter` policy (IcpConfig).
 *
 * Score (additive, clamped to 0–100):
 *   size in [employee_min, employee_max]        +weights.company_size
 *   size in [employee_near_min, employee_min)    +weights.company_size_near
 *   size > employee_max                          +weights.company_size_large
 *   industry matches                             +weights.industry
 *   country matches                              +weights.country
 *   source matches an intent keyword             +weights.intent
 *   title matches a title keyword                +weights.title
 * Hard gates: free email (if block_free_email), size < employee_floor.
 * Tiers: score >= tier_1 → tier_1, >= tier_2 → tier_2, else not_icp.
 */

import type { Lead, Company } from '../../domain/db-types.js'
import type { IcpTier, QualificationParameters } from './types.js'
import type { IcpConfig } from './icp-config.js'

/**
 * Exported for reuse in enrich.ts (Apollo org enrichment domain gate).
 * Do not duplicate this list — import from here.
 */
export const FREE_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'protonmail.com', 'proton.me', 'mail.com', 'zoho.com',
  'yandex.com', 'yandex.ru', 'tutanota.com', 'fastmail.com',
  'inbox.com', 'live.com', 'msn.com', 'me.com', 'mac.com',
])

function normalise(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim()
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some(n => haystack.includes(n))
}

export function scoreIcp(lead: Lead, company: Company | null, config: IcpConfig): QualificationParameters {
  // ── Hard gate: free/disposable email providers ─────────────────────────────
  // Uses the module-level FREE_EMAIL_PROVIDERS export (also used by enrich.ts for Apollo).
  const emailDomain = lead.email?.split('@')[1]?.toLowerCase().trim()
  if (config.block_free_email && emailDomain && FREE_EMAIL_PROVIDERS.has(emailDomain)) {
    return {
      is_icp_fit: false,
      icp_score: 0,
      icp_tier: 'not_icp' as const,
      reason_codes: ['DISQUALIFIED_FREE_EMAIL_PROVIDER'],
    }
  }

  // ── Hard gate: micro-companies are never ICP regardless of title/source ─────
  const companySize = company?.employee_count ?? null
  if (companySize !== null && companySize < config.employee_floor) {
    return {
      is_icp_fit: false,
      icp_score: 0,
      icp_tier: 'not_icp' as const,
      reason_codes: ['DISQUALIFIED_TOO_SMALL'],
    }
  }

  const { weights: w } = config
  let score = 0
  const reason_codes: string[] = []

  // ── Company size ────────────────────────────────────────────────────────────
  const size = company?.employee_count ?? null
  if (size !== null) {
    if (size >= config.employee_min && size <= config.employee_max) {
      score += w.company_size
      reason_codes.push('ICP_COMPANY_SIZE_IN_RANGE')
    } else if (size >= config.employee_near_min && size < config.employee_min) {
      score += w.company_size_near
      reason_codes.push('ICP_COMPANY_SIZE_NEAR_RANGE')
    } else if (size > config.employee_max) {
      score += w.company_size_large
      reason_codes.push('ICP_COMPANY_SIZE_LARGE')
    } else {
      reason_codes.push('NOT_ICP_TOO_SMALL')
    }
  } else {
    reason_codes.push('ENRICHMENT_MISSING_COMPANY_SIZE')
  }

  // ── Industry ────────────────────────────────────────────────────────────────
  const industry = normalise(company?.industry)
  if (industry && matchesAny(industry, config.industries)) {
    score += w.industry
    reason_codes.push('ICP_INDUSTRY_SAAS')
  } else if (industry) {
    reason_codes.push('NOT_ICP_INDUSTRY_MISMATCH')
  } else {
    reason_codes.push('ENRICHMENT_MISSING_INDUSTRY')
  }

  // ── Region ──────────────────────────────────────────────────────────────────
  const country = (company?.country ?? (lead as any)?.country ?? '').toUpperCase().trim()
  if (country && config.countries.includes(country)) {
    score += w.country
    reason_codes.push(country === 'US' || country === 'CA' ? 'ICP_REGION_NA' : 'ICP_REGION_EMEA_APAC')
  } else if (country) {
    reason_codes.push('NOT_ICP_REGION_EXCLUDED')
  } else {
    reason_codes.push('ENRICHMENT_MISSING_REGION')
  }

  // ── High-intent form ────────────────────────────────────────────────────────
  const source = normalise(lead.source)
  if (matchesAny(source, config.intent_keywords)) {
    score += w.intent
    reason_codes.push('ICP_HIGH_INTENT_FORM')
  }

  // ── Senior title ────────────────────────────────────────────────────────────
  // NOTE: lead.title comes from the HubSpot form submission (what the lead typed), NOT from
  // enrichment. The current Apollo plan provides organization/company data only — no person-level
  // enrichment (title, seniority, role) is available from this source.
  // If the form doesn't capture title, this signal will be absent for most leads.
  // ICP scoring is therefore primarily driven by company signals (size, industry, region).
  const title = normalise(lead.title)
  if (title && matchesAny(title, config.title_keywords)) {
    score += w.title
    reason_codes.push('ICP_SENIOR_TITLE')
  }

  // ── Enrichment completely missing ───────────────────────────────────────────
  if (!company && !lead.title && !lead.source) {
    reason_codes.push('ENRICHMENT_MISSING_ALL_FIELDS')
  }

  // ── Tier calculation ────────────────────────────────────────────────────────
  const clampedScore = Math.min(100, Math.max(0, score))
  let icp_tier: IcpTier
  if (clampedScore >= config.tier_thresholds.tier_1) {
    icp_tier = 'tier_1'
  } else if (clampedScore >= config.tier_thresholds.tier_2) {
    icp_tier = 'tier_2'
  } else {
    icp_tier = 'not_icp'
    if (!reason_codes.some(c => c.startsWith('NOT_ICP'))) {
      reason_codes.push('NOT_ICP_SCORE_TOO_LOW')
    }
  }

  return {
    is_icp_fit: icp_tier !== 'not_icp',
    icp_score: clampedScore,
    icp_tier,
    reason_codes,
  }
}
