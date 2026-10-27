/**
 * event-log.ts
 * Append-only event log writer.
 *
 * RULES:
 * - writeEvent() inserts ONE row and returns it
 * - NEVER updates. NEVER deletes.
 * - decisionSnapshot REQUIRED — throws before DB write if missing/null
 * - All writes go through this function — never raw DB inserts elsewhere
 * - After every insert, processEvent() is called to project into action_execution_state
 *   so the idempotency check in ActionExecutor always has current data.
 */

import { getDb } from '../db/client.js'
import { processEvent } from './event-processor.js'
import type { WriteEventInput, EventLogRow } from './event.types.js'

/**
 * Appends one immutable event to event_log.
 * Throws immediately if decisionSnapshot is missing or null.
 * Never updates existing rows. Never deletes.
 * Automatically projects the event into action_execution_state via processEvent().
 */
export async function writeEvent(input: WriteEventInput): Promise<EventLogRow> {
  // Guard: decisionSnapshot is non-negotiable — enforce before any DB call
  if (!input.decisionSnapshot) {
    throw new Error(
      `[event-log] writeEvent called without decisionSnapshot. ` +
      `Event type: ${input.eventType}, lead: ${input.leadId}. ` +
      `decisionSnapshot is required on every event — see GEMINI.md rule #3.`
    )
  }

  const db = getDb()

  const row = {
    organization_id:   input.organizationId,
    workflow_run_id:   input.workflowRunId,
    play_instance_id:  input.playInstanceId,
    lead_id:           input.leadId,
    event_type:        input.eventType,
    actor_type:        input.actorType,
    actor_id:          input.actorId ?? null,
    agent_version:     input.agentVersion ?? null,
    model_provider:    input.modelProvider ?? null,
    model_name:        input.modelName ?? null,
    prompt_version:    input.promptVersion ?? null,
    decision_snapshot: input.decisionSnapshot,          // JSONB NOT NULL
    proposed_action:   input.proposedAction ?? null,
    candidate_actions: input.candidateActions ?? null,
    policy_rule_id:    input.policyRuleId ?? null,
    policy_name:       input.policyName ?? null,
    policy_passed:     input.policyPassed ?? null,
    policy_decision:   input.policyDecision ?? null,
    external_system:   input.externalSystem ?? null,
    external_id:       input.externalId ?? null,
    idempotency_key:   input.idempotencyKey ?? null,
    event_status:      input.eventStatus,
    error_code:        input.errorCode ?? null,
    error_message:     input.errorMessage ?? null,
    error_raw:         input.errorRaw ?? null,
    duration_ms:       input.durationMs ?? null,
  }

  const { data, error } = await db
    .from('event_log')
    .insert(row)
    .select()
    .single()

  if (error) {
    throw new Error(`[event-log] Failed to write event: ${error.message} (code: ${error.code})`)
  }

  const eventRow = data as EventLogRow

  // Project event into action_execution_state for idempotency tracking.
  // processEvent() is fire-and-forget — never block the caller on projection failure.
  processEvent(eventRow).catch((err: unknown) => {
    console.error('[event-log] processEvent failed (non-fatal):', err)
  })

  return eventRow
}
