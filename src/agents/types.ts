export type ProposedAction = {
  actionId: string
  type: string
  target: {
    leadId: string
    organizationId: string
  }
  rationale: {
    reasonCodes: string[]
    evidenceIds: string[]
  }
  decisionRiskScore: number
  rawConfidence: number
  parameters: Record<string, unknown>
  idempotencyKey: string
  constraints: {
    requiredPolicyIds: string[]
  }
}
