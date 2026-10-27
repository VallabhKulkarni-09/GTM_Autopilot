/**
 * qualification.types.ts
 * Input/output types for QualificationAgent v1.
 */

import type { Lead, Company, Evidence, PolicyRule } from '../../domain/db-types.js'

export type IcpTier = 'tier_1' | 'tier_2' | 'not_icp'

export type QualificationInput = {
  lead: Lead
  company: Company | null
  enrichmentEvidence: Evidence[]
  icpPolicyRules: PolicyRule[]
}

export type QualificationParameters = {
  is_icp_fit: boolean
  icp_score: number      // 0–100, deterministic
  icp_tier: IcpTier
  reason_codes: string[] // SCREAMING_SNAKE_CASE
}

export type ProposedAction = {
  type: string
  parameters: Record<string, unknown>
  decisionRiskScore: number
  rawConfidence: number
}
