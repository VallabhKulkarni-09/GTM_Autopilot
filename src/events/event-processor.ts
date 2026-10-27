/**
 * event-processor.ts
 * Derives action_execution_state from the event stream.
 * Called after every event_log insert.
 *
 * Pattern: read event → update mutable projection (action_execution_state)
 * For unknown event types: log warning, do nothing, never throw.
 */

import { getDb } from '../db/client.js'
import type { EventLogRow } from './event.types.js'

export async function processEvent(event: EventLogRow): Promise<void> {
  const key = event.idempotency_key

  switch (event.event_type) {
    case 'action_proposed': {
      if (!key) break
      await getDb().from('action_execution_state').upsert({
        idempotency_key:  key,
        organization_id:  event.organization_id,
        play_instance_id: event.play_instance_id,
        lead_id:          event.lead_id,
        action_type:      (event.proposed_action as any)?.type ?? 'unknown',
        status:           'proposed',
        proposed_at:      event.occurred_at,
        agent_name:       (event.decision_snapshot as any)?.agentName ?? null,
        agent_version:    event.agent_version,
      // ignoreDuplicates: a re-proposal (job retry) must not reset a 'succeeded' row
      // back to 'proposed', or the executor's dedupe check would let it run twice.
      }, { onConflict: 'organization_id,idempotency_key', ignoreDuplicates: true })
      break
    }

    case 'action_execution_started': {
      if (!key) break
      await getDb().from('action_execution_state')
        .update({ status: 'started', started_at: event.occurred_at })
        .eq('idempotency_key', key)
        .eq('organization_id', event.organization_id)
      break
    }

    case 'action_execution_succeeded': {
      if (!key) break
      await getDb().from('action_execution_state')
        .update({
          status:         'succeeded',
          completed_at:   event.occurred_at,
          external_system: event.external_system,
          external_id:     event.external_id,
        })
        .eq('idempotency_key', key)
        .eq('organization_id', event.organization_id)
      break
    }

    case 'action_execution_failed': {
      if (!key) break
      await getDb().from('action_execution_state')
        .update({
          status:        'failed',
          completed_at:  event.occurred_at,
          error_code:    event.error_code,
          error_message: event.error_message,
        })
        .eq('idempotency_key', key)
        .eq('organization_id', event.organization_id)
      break
    }

    case 'action_execution_deduplicated': {
      if (!key) break
      await getDb().from('action_execution_state')
        .update({ status: 'deduplicated', completed_at: event.occurred_at })
        .eq('idempotency_key', key)
        .eq('organization_id', event.organization_id)
      break
    }

    // All other event types: no projection update needed
    case 'webhook_received':
    case 'idempotency_check_passed':
    case 'idempotency_check_failed':
    case 'enrichment_requested':
    case 'enrichment_succeeded':
    case 'enrichment_failed':
    case 'enrichment_skipped':
    case 'dedup_passed':
    case 'dedup_rejected':
    case 'action_risk_assessed':
    case 'policy_validated':
    case 'policy_rejected':
    case 'sla_checked':
    case 'sla_breached':
    case 'escalation_triggered':
    case 'escalation_sent':
    case 'human_review_requested':
    case 'human_approved':
    case 'human_rejected':
    case 'play_completed':
    case 'play_failed':
    case 'play_paused':
    case 'play_resumed':
    case 'play_marked_nurture':
    case 'play_marked_duplicate':
      // No action_execution_state update for these event types
      break

    default: {
      // Unknown event type — log warning, do not throw
      const unknownType = (event as any).event_type
      console.warn(`[event-processor] Unknown event type: ${unknownType} — skipping projection update`)
      break
    }
  }
}
