/**
 * validators.ts
 * ProposedAction validation against the ActionRiskRegistry.
 * Determines whether human approval is required.
 */

import { getDb } from '../db/client.js'
import type { ActionRiskRegistry } from '../domain/db-types.js'
import type { ProposedAction } from '../agents/qualification/types.js'
import type { ValidationResult } from './types.js'

export async function validateProposedAction(
  action: ProposedAction,
  organizationId: string
): Promise<ValidationResult> {
  // Load registry entry for this action type
  const { data, error } = await getDb()
    .from('action_risk_registry')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('action_type', action.type)
    .single()

  // Unknown action type — approve with warning
  if (error || !data) {
    return {
      approved: true,
      riskLevel: 'unknown',
      requiresHumanApproval: false,
      appliedRegistryEntry: null,
      reason: `No risk registry entry for action type "${action.type}" — approved with warning`,
    }
  }

  const entry = data as ActionRiskRegistry
  const requiresHumanApproval = action.decisionRiskScore >= entry.max_risk_score

  return {
    approved: !requiresHumanApproval,
    riskLevel: entry.risk_level,
    requiresHumanApproval,
    appliedRegistryEntry: entry,
    reason: requiresHumanApproval
      ? `Action "${action.type}" risk score ${action.decisionRiskScore} >= threshold ${entry.max_risk_score} — requires human approval`
      : `Action "${action.type}" approved — risk score ${action.decisionRiskScore} < threshold ${entry.max_risk_score}`,
  }
}
