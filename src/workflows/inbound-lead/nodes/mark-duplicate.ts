import { randomUUID } from 'crypto'
import { WorkflowState } from '../state.js'
import { executeAction } from '../../../actions/executor.js'
import { writeEvent } from '../../../events/event-log.js'
import { buildDecisionSnapshot } from '../../../evidence/context-builder.js'
import type { ProposedAction } from '../../../actions/types.js'

export async function markDuplicate(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const decisionSnapshot = await buildDecisionSnapshot(state as any)
  try {
    const action: ProposedAction = {
      actionId: randomUUID(),
      type: 'mark_duplicate',
      target: { leadId: state.leadId, organizationId: state.organizationId },
      rationale: { reasonCodes: ['DUPLICATE_EMAIL'], evidenceIds: [] },
      decisionRiskScore: 0.0,
      rawConfidence: 1.0,
      parameters: {},
      idempotencyKey: `${state.organizationId}:${state.workflowRunId}:mark_duplicate`,
      constraints: { requiredPolicyIds: [] },
    }
    await executeAction(action, {} as any, state.organizationId, state.workflowRunId, state.playInstanceId, decisionSnapshot)
    await writeEvent({
      organizationId: state.organizationId,
      workflowRunId: state.workflowRunId,
      playInstanceId: state.playInstanceId,
      leadId: state.leadId,
      eventType: 'play_marked_duplicate',
      actorType: 'system',
      decisionSnapshot,
      eventStatus: 'success'
    })
    return { currentStep: 'mark_duplicate' }
  } catch (e: any) {
    await writeEvent({
      organizationId: state.organizationId,
      workflowRunId: state.workflowRunId,
      playInstanceId: state.playInstanceId,
      leadId: state.leadId,
      eventType: 'action_execution_failed',
      actorType: 'system',
      decisionSnapshot,
      eventStatus: 'failed',
      errorMessage: e.message
    })
    throw e
  }
}
