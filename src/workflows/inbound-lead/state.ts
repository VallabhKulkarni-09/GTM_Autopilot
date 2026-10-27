import { Lead, Company, Evidence, ReviewDecision } from '../../domain/db-types.js'
import { ProposedAction } from '../../agents/types.js'

export type WorkflowState = {
  organizationId: string
  workflowRunId: string
  leadId: string
  playInstanceId: string
  lead: Lead
  company: Company | null
  evidence: Evidence[]
  qualificationResult: ProposedAction | null
  routingResult: ProposedAction | null
  /** Set by human_review after a person decides (resume value). */
  reviewDecision?: ReviewDecision | null
  currentStep: string
  error: string | null
}
