/**
 * types.ts — Shared types for the action layer.
 * ProposedAction extends the minimal type from qualification/types.ts with
 * the full fields required by the ActionExecutor (actionId, target, etc).
 *
 * ConnectorError is defined ONCE in src/connectors/base.ts and re-exported here.
 * Never re-declare it — duplicate class declarations break instanceof checks
 * when the two class objects are different references across module boundaries.
 */

import type { ConnectorName, DecisionSnapshot, RiskLevel, ActionRiskRegistry } from '../domain/db-types.js'
// Single source of truth for ConnectorError — import for use in type annotations
import { ConnectorError } from '../connectors/base.js'
// Re-export so consumers only need to import from this module
export { ConnectorError } from '../connectors/base.js'

export type { ConnectorName, DecisionSnapshot }

export type ActionType =
  | 'qualify_lead'
  | 'assign_owner'
  | 'start_sequence'
  | 'mark_nurture'
  | 'mark_duplicate'
  | 'request_human_review'
  | 'escalate'

export type ProposedAction = {
  actionId: string                      // UUID
  type: ActionType
  target: {
    leadId: string
    organizationId: string
  }
  rationale: {
    reasonCodes: string[]               // SCREAMING_SNAKE_CASE
    evidenceIds: string[]
  }
  decisionRiskScore: number             // 0.0 – 1.0
  rawConfidence: number                 // 0.0 – 1.0
  parameters: Record<string, unknown>
  idempotencyKey: string               // organizationId:workflowRunId:actionId
  constraints: {
    requiredPolicyIds: string[]
  }
}

export type ActionExecutionResult = {
  success: boolean
  externalSystem?: ConnectorName
  externalId?: string
  output?: Record<string, unknown>
  error?: ConnectorError
}

export type ValidationResult = {
  approved: boolean
  riskLevel: RiskLevel | 'unknown'
  requiresHumanApproval: boolean
  appliedRegistryEntry: ActionRiskRegistry | null
  reason: string
}
