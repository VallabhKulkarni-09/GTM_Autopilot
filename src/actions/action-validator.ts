/**
 * action-validator.ts
 * Thin wrapper: calls the policy engine's validateProposedAction.
 * Does NOT execute anything — validation only.
 */

import { validateProposedAction } from '../policies/validators.js'
import type { ProposedAction, ValidationResult } from './types.js'

export async function validateAction(
  action: ProposedAction,
  organizationId: string
): Promise<ValidationResult> {
  return validateProposedAction(action as any, organizationId) as Promise<ValidationResult>
}
