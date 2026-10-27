/**
 * human-review.ts — durable pause for a routing decision a person must make.
 *
 * First run: interrupt() saves the checkpoint (Postgres) and the graph stops; the play is
 * already 'paused' (route.ts executed request_human_review). The API records the decision
 * and the resume-play worker resumes this thread with Command({ resume: ReviewDecision }).
 *
 * On resume this node re-runs from the top and interrupt() returns the decision:
 *   approved → the human-chosen rep is assigned through the ActionExecutor (Salesforce
 *              Lead owner + Task, same as automatic routing), then first_touch
 *   rejected → mark_nurture (edge in graph.ts)
 *
 * The person's approval is the risk decision for this action, so the validator is not
 * asked again (it is what sent the lead here). action_proposed records actor = human.
 */

import { interrupt } from '@langchain/langgraph'
import { WorkflowState } from '../state.js'
import { executeAction } from '../../../actions/executor.js'
import { writeEvent } from '../../../events/event-log.js'
import { buildDecisionSnapshot } from '../../../evidence/context-builder.js'
import { getConnectors } from '../../../connectors/factory.js'
import type { ProposedAction } from '../../../actions/types.js'
import type { ConnectorRegistry } from '../../../actions/action-executor.js'
import type { ReviewDecision, ReviewKind } from '../../../domain/db-types.js'

export type ReviewRequest = { kind: ReviewKind; playInstanceId: string; reasonCodes: string[] }

export const HUMAN_REVIEW_AGENT = { name: 'human-review', version: '1.0.0' } as const

/** Validates the resume value; a malformed decision must never be applied. */
export function assertReviewDecision(value: unknown, kind: ReviewKind): ReviewDecision {
  const d = value as ReviewDecision | null
  if (!d || (d.decision !== 'approved' && d.decision !== 'rejected') || d.kind !== kind || !d.actor_user_id) {
    throw new Error(`REVIEW_DECISION_INVALID: expected a ${kind} review decision, got ${JSON.stringify(value)}`)
  }
  if (kind === 'routing' && d.decision === 'approved' && !d.owner_id) {
    throw new Error('REVIEW_DECISION_INVALID: an approved routing review needs the rep to assign')
  }
  return d
}

export async function humanReview(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const request: ReviewRequest = {
    kind:           'routing',
    playInstanceId: state.playInstanceId,
    reasonCodes:    (state.routingResult?.parameters?.reason_codes as string[] | undefined) ?? [],
  }
  const decision = assertReviewDecision(interrupt<ReviewRequest, unknown>(request), 'routing')

  if (decision.decision === 'rejected') {
    return { reviewDecision: decision, currentStep: 'human_review' }
  }

  const decisionSnapshot = await buildDecisionSnapshot({
    organizationId: state.organizationId,
    leadId:         state.leadId,
    workflowRunId:  state.workflowRunId,
    agentName:      HUMAN_REVIEW_AGENT.name,
    agentVersion:   HUMAN_REVIEW_AGENT.version,
  })
  decisionSnapshot.humanReviewContext = {
    actorUserId:         decision.actor_user_id,
    decision:            'approved',
    playStateAtDecision: { review_kind: 'routing', reason_codes: request.reasonCodes, owner_id: decision.owner_id, note: decision.note },
  }

  const parameters = {
    ...(state.routingResult?.parameters ?? {}),
    recommended_owner_id:   decision.owner_id,
    recommended_owner_name: decision.owner_name,
    owner_name:             decision.owner_name,
    // Not a round-robin queue: a human pick must not advance any territory's counter.
    queue_name:             'human_review',
    reason_codes:           ['HUMAN_ASSIGNED', ...request.reasonCodes],
  }
  const action: ProposedAction = {
    actionId:          'assign_owner_human_review',
    type:              'assign_owner',
    target:            { leadId: state.leadId, organizationId: state.organizationId },
    rationale:         { reasonCodes: parameters.reason_codes, evidenceIds: decisionSnapshot.evidenceIds ?? [] },
    decisionRiskScore: 0.0,
    rawConfidence:     1.0,
    parameters,
    idempotencyKey:    `${state.organizationId}:${state.workflowRunId}:assign_owner_human_review`,
    constraints:       { requiredPolicyIds: [] },
  }

  let handedToExecutor = false
  try {
    await writeEvent({
      organizationId: state.organizationId,
      workflowRunId:  state.workflowRunId,
      playInstanceId: state.playInstanceId,
      leadId:         state.leadId,
      eventType:      'action_proposed',
      actorType:      'human',
      actorId:        decision.actor_user_id,
      idempotencyKey: action.idempotencyKey,
      proposedAction: action as unknown as Record<string, unknown>,
      decisionSnapshot,
      eventStatus:    'success',
    })
    const sf = await getConnectors(state.organizationId).salesforce()
    const connectors: Partial<ConnectorRegistry> = sf ? { salesforce: sf as unknown as ConnectorRegistry['salesforce'] } : {}
    handedToExecutor = true
    await executeAction(action, connectors as ConnectorRegistry, state.organizationId, state.workflowRunId, state.playInstanceId, decisionSnapshot)
  } catch (e: any) {
    if (!handedToExecutor) {
      await writeEvent({
        organizationId: state.organizationId,
        workflowRunId:  state.workflowRunId,
        playInstanceId: state.playInstanceId,
        leadId:         state.leadId,
        eventType:      'action_execution_failed',
        actorType:      'system',
        decisionSnapshot,
        eventStatus:    'failed',
        errorCode:      e?.code ?? 'HUMAN_REVIEW_FAILED',
        errorMessage:   e?.message ?? String(e),
      })
    }
    throw e
  }

  return {
    reviewDecision: decision,
    routingResult:  { type: 'assign_owner', parameters, decisionRiskScore: 0, rawConfidence: 1 } as any,
    currentStep:    'human_review',
  }
}
