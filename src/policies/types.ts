/**
 * policy.types.ts
 * Types for the policy engine — evaluation results and validation results.
 */

import type { PolicyRule, ActionRiskRegistry } from '../domain/db-types.js'

export type PolicyEvaluationResult = {
  passed: boolean
  ruleName: string
  ruleId: string
  reason: string       // human-readable, for audit log
  reasonCode: string   // SCREAMING_SNAKE_CASE, for event_log
}

export type ValidationResult = {
  approved: boolean
  riskLevel: string
  requiresHumanApproval: boolean
  appliedRegistryEntry: ActionRiskRegistry | null
  reason: string
}

export type ConditionOperator =
  | 'in' | 'not_in' | 'eq' | 'neq'
  | 'gte' | 'lte' | 'contains'
  | 'and' | 'or'

export type Condition = {
  field?: string
  operator: ConditionOperator
  value?: unknown
  values?: unknown[]
  conditions?: Condition[]  // for 'and' / 'or'
}

export type { PolicyRule, ActionRiskRegistry }
