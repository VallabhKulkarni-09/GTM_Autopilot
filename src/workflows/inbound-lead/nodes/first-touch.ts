/**
 * first-touch.ts — sequence enrollment node (v1: Apollo Sequences only).
 *
 * Pipeline: outreach policy → ProposedAction(start_sequence) → action_proposed event
 *           → validateAction → ActionExecutor (the only caller of the Apollo connector).
 *
 * Every outcome is explicit in the event log:
 *   - enroll          → executor finds/creates the Apollo contact and adds it to the sequence
 *   - manual          → admin chose "rep follows up by hand" for this fit level (or active deal);
 *                       succeeded with enrolled=false, lead stays in 'routing' under the SLA timer
 *   - not_configured  → executor escalates with a specific code (OUTREACH_TIER_NOT_SET, ...)
 *   - Apollo not connected → executor escalates with NO_SEP_CONNECTOR_AVAILABLE
 *
 * Outreach / Salesloft code stays in src/connectors but is never constructed in v1.
 */

import { interrupt, isGraphInterrupt } from '@langchain/langgraph'
import { WorkflowState } from '../state.js'
import { assertReviewDecision } from './human-review.js'
import { executeAction } from '../../../actions/executor.js'
import { validateAction } from '../../../actions/validator.js'
import { writeEvent } from '../../../events/event-log.js'
import { buildDecisionSnapshot } from '../../../evidence/context-builder.js'
import { getConnectors } from '../../../connectors/factory.js'
import { selectOutreachPolicy, planOutreach, type OutreachPlan } from '../../../policies/outreach-policy.js'
import type { ProposedAction } from '../../../actions/types.js'
import type { ApolloStartSequenceParams, ConnectorRegistry } from '../../../actions/action-executor.js'

export const FIRST_TOUCH_AGENT = { name: 'first-touch', version: '1.0.0' } as const

/** Turns the policy decision into executor parameters. Pure. */
export function buildStartSequenceParams(
  plan: OutreachPlan | { kind: 'not_configured'; tier: string | null; code: string; message: string },
  policy: { id: string; version: number } | null,
): ApolloStartSequenceParams {
  const base = {
    provider: 'apollo' as const,
    tier: plan.tier,
    outreach_policy_id: policy?.id ?? null,
    outreach_policy_version: policy?.version ?? null,
  }
  switch (plan.kind) {
    case 'enroll':
      return { ...base, plan: 'enroll', apollo_sequence_id: plan.sequenceId, apollo_sequence_name: plan.sequenceName, apollo_email_account_id: plan.emailAccountId }
    case 'manual':
      return { ...base, plan: 'manual', reason_code: plan.reason }
    case 'not_configured':
      return { ...base, plan: 'not_configured', reason_code: plan.code, reason_message: plan.message }
  }
}

export async function firstTouch(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const decisionSnapshot = await buildDecisionSnapshot({
    organizationId: state.organizationId,
    leadId:         state.leadId,
    workflowRunId:  state.workflowRunId,
    agentName:      FIRST_TOUCH_AGENT.name,
    agentVersion:   FIRST_TOUCH_AGENT.version,
  })
  let handedToExecutor = false

  try {
    // ── 1. Outreach policy → plan ────────────────────────────────────────────
    let plan: Parameters<typeof buildStartSequenceParams>[0]
    let policy: { id: string; version: number } | null = null
    try {
      const { rule, config } = selectOutreachPolicy(decisionSnapshot.policies ?? [])
      policy = { id: rule.id, version: rule.version }
      decisionSnapshot.outreachPolicy = policy
      // Lead row (re-read for the snapshot) is the source of truth for the tier.
      const tier = (decisionSnapshot.lead?.icp_tier ?? (state.qualificationResult?.parameters?.icp_tier as string | undefined) ?? null)
      const activeDeal = (state.routingResult as any)?._bypassQualification === true
      plan = planOutreach(config, tier, activeDeal)
    } catch (e: any) {
      const code = String(e?.message ?? '').startsWith('OUTREACH_POLICY_MISSING') ? 'OUTREACH_POLICY_MISSING' : 'OUTREACH_POLICY_INVALID'
      plan = { kind: 'not_configured', tier: decisionSnapshot.lead?.icp_tier ?? null, code, message: e?.message ?? code }
    }
    const parameters = buildStartSequenceParams(plan, policy)

    const action: ProposedAction = {
      actionId:          'start_sequence',
      type:              'start_sequence',
      target:            { leadId: state.leadId, organizationId: state.organizationId },
      rationale:         { reasonCodes: parameters.reason_code ? [parameters.reason_code] : [`OUTREACH_${plan.kind.toUpperCase()}`], evidenceIds: decisionSnapshot.evidenceIds ?? [] },
      decisionRiskScore: 0.0,
      rawConfidence:     1.0,
      parameters:        parameters as unknown as Record<string, unknown>,
      idempotencyKey:    `${state.organizationId}:${state.workflowRunId}:start_sequence`,
      constraints:       { requiredPolicyIds: policy ? [policy.id] : [] },
    }

    await writeEvent({
      organizationId: state.organizationId,
      workflowRunId:  state.workflowRunId,
      playInstanceId: state.playInstanceId,
      leadId:         state.leadId,
      eventType:      'action_proposed',
      actorType:      'agent',
      actorId:        FIRST_TOUCH_AGENT.name,
      agentVersion:   FIRST_TOUCH_AGENT.version,
      idempotencyKey: action.idempotencyKey,
      proposedAction: action as unknown as Record<string, unknown>,
      decisionSnapshot,
      eventStatus:    'success',
    })

    // ── 2. Risk / policy validation ──────────────────────────────────────────
    // Needs sign-off → pause durably. interrupt() stops the graph here; on resume this
    // node re-runs from the top (the review action is deduplicated by the executor) and
    // interrupt() returns the person's decision.
    const { approved, requiresHumanApproval } = await validateAction(action as any, state.organizationId)
    if (!approved || requiresHumanApproval) {
      const review: ProposedAction = {
        ...action,
        actionId:       'request_human_review_first_touch',
        type:           'request_human_review',
        parameters:     { ...action.parameters, review_kind: 'sequence' },
        idempotencyKey: `${state.organizationId}:${state.workflowRunId}:request_human_review_first_touch`,
      }
      // Proposed with its key so the projection row exists: on resume the executor sees
      // 'succeeded' and deduplicates instead of re-pausing and clearing the decision.
      await writeEvent({
        organizationId: state.organizationId,
        workflowRunId:  state.workflowRunId,
        playInstanceId: state.playInstanceId,
        leadId:         state.leadId,
        eventType:      'action_proposed',
        actorType:      'agent',
        actorId:        FIRST_TOUCH_AGENT.name,
        agentVersion:   FIRST_TOUCH_AGENT.version,
        idempotencyKey: review.idempotencyKey,
        proposedAction: review as unknown as Record<string, unknown>,
        decisionSnapshot,
        eventStatus:    'success',
      })
      handedToExecutor = true
      await executeAction(review, {} as any, state.organizationId, state.workflowRunId, state.playInstanceId, decisionSnapshot)
      const decision = assertReviewDecision(
        interrupt({ kind: 'sequence', playInstanceId: state.playInstanceId, reasonCodes: action.rationale.reasonCodes }),
        'sequence',
      )
      decisionSnapshot.humanReviewContext = {
        actorUserId:         decision.actor_user_id,
        decision:            decision.decision,
        playStateAtDecision: { review_kind: 'sequence', plan: parameters.plan, note: decision.note },
      }
      if (decision.decision === 'rejected') {
        // Rejected = no automated outreach; the assigned rep follows up by hand (SLA still applies).
        action.parameters = { ...action.parameters, plan: 'manual', reason_code: 'HUMAN_REJECTED_SEQUENCE' }
        action.rationale = { ...action.rationale, reasonCodes: ['HUMAN_REJECTED_SEQUENCE'] }
        parameters.plan = 'manual'
      }
      handedToExecutor = false
    }

    // ── 3. Connector (only needed to enroll) ─────────────────────────────────
    // Not connected → null → executor escalates NO_SEP_CONNECTOR_AVAILABLE.
    // Connected but undecryptable → throws, the job fails and is logged below.
    const connectors: Partial<ConnectorRegistry> = {}
    if (parameters.plan === 'enroll') {
      const apollo = await getConnectors(state.organizationId).apollo()
      if (apollo) connectors.apollo = apollo
    }

    handedToExecutor = true
    await executeAction(action, connectors as ConnectorRegistry, state.organizationId, state.workflowRunId, state.playInstanceId, decisionSnapshot)
    return { currentStep: 'first_touch' }
  } catch (e: any) {
    if (isGraphInterrupt(e)) throw e  // a durable pause, not a failure
    // The executor already wrote action_execution_failed for its own failures.
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
        errorCode:      e?.code ?? 'FIRST_TOUCH_FAILED',
        errorMessage:   e?.message ?? String(e),
      })
    }
    // Already escalated for a missing setting (e.g. no sequence chosen): the play stays
    // visible under Needs attention. Do not fail the job — a retry would repeat the play.
    if (e?.retryable === false) return { currentStep: 'first_touch' }
    throw e
  }
}
