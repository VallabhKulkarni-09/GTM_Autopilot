import { WorkflowState } from '../state.js'
import { writeEvent } from '../../../events/event-log.js'
import { buildDecisionSnapshot } from '../../../evidence/context-builder.js'

export async function complete(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const decisionSnapshot = await buildDecisionSnapshot(state as any)
  try {
    // Found live: when outreach was escalated (e.g. no sequence chosen), the lead stays at
    // stage 'routing' and nobody has contacted it — the timeline must not say "All steps
    // finished" in green. Record that the automated steps ended, with outreach still pending.
    const outreachPending = (decisionSnapshot as any)?.lead?.stage === 'routing'
    await writeEvent({
      organizationId: state.organizationId,
      workflowRunId: state.workflowRunId,
      playInstanceId: state.playInstanceId,
      leadId: state.leadId,
      eventType: 'play_completed',
      actorType: 'system',
      decisionSnapshot,
      eventStatus: outreachPending ? 'skipped' : 'success',
      ...(outreachPending ? { errorMessage: 'Automated steps finished, but the lead was not added to a sequence yet' } : {}),
    })
    return { currentStep: 'complete' }
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
