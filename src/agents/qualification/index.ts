/**
 * index.ts — QualificationAgent v1
 * Rule-based. Zero LLM calls. Zero external API calls.
 * decision_risk_score: 0.0, raw_confidence: 1.0
 *
 * Scoring config comes only from input.icpPolicyRules (rule_type='icp_filter').
 * No active ICP policy → throws ICP_POLICY_MISSING (never falls back to built-in values).
 */

import { scoreIcp } from './rules.js'
import { selectIcpPolicy } from './icp-config.js'
import type { QualificationInput, ProposedAction } from './types.js'

export class QualificationAgent {
  readonly name = 'qualification-agent'
  readonly version = '1.1.0'

  /** Primary API — used by the rule-based v1 pipeline */
  run(input: QualificationInput): ProposedAction {
    const { rule, config } = selectIcpPolicy(input.icpPolicyRules)
    const params = scoreIcp(input.lead, input.company, config)
    return {
      type: 'qualify_lead',
      parameters: { ...params, icp_policy_id: rule.id, icp_policy_version: rule.version },
      decisionRiskScore: 0.0,   // rule-based = deterministic = no risk
      rawConfidence: 1.0,
    }
  }

  /** Async execute() alias — compatible with LangGraph node interface */
  async execute(input: QualificationInput, _context?: any): Promise<ProposedAction> {
    return this.run(input)
  }
}

export const qualificationAgent = new QualificationAgent()
