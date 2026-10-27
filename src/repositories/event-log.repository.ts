/**
 * event-log.repository.ts
 * Repository functions for event_log and action_execution_state.
 *
 * event_log: write-only (writeEvent) + one read (getLeadTimeline)
 * action_execution_state: upsert + update (via event-processor)
 *
 * GEMINI.md Rule #1: organization_id on EVERY query. No exceptions.
 */

import { getDb } from '../db/client.js'
import { writeEvent } from '../events/event-log.js'
import type { EventLogRow } from '../events/event.types.js'

// Re-export writeEvent as the canonical repository method
export { writeEvent }

/**
 * The ONLY read query allowed on event_log from application code.
 * Returns events ORDER BY occurred_at ASC.
 */
export async function getLeadTimeline(
  organizationId: string,
  leadId: string
): Promise<EventLogRow[]> {
  const { data, error } = await getDb()
    .from('event_log')
    .select('*')
    .eq('organization_id', organizationId)   // Rule #1 — always org-scoped
    .eq('lead_id', leadId)
    .order('occurred_at', { ascending: true })

  if (error) throw new Error(`[event-log-repo] getLeadTimeline failed: ${error.message}`)
  return (data ?? []) as EventLogRow[]
}

/**
 * Checks if an event with this idempotency key already exists within an org.
 * Used by the webhook handler for deduplication.
 *
 * GEMINI.md Rule #1: organizationId is REQUIRED. Never query globally.
 * For webhook handlers without a JWT, pass the org UUID resolved from
 * connector_config.portal_id (see inbound-lead.worker.ts resolveOrganizationId).
 * If organizationId cannot be resolved yet, the idempotency key alone provides
 * a best-effort global guard (HubSpot eventIds are globally unique per portal).
 */
export async function existsByIdempotencyKey(
  key: string,
  organizationId?: string
): Promise<boolean> {
  let query = getDb()
    .from('event_log')
    .select('id', { count: 'exact', head: true })
    .eq('idempotency_key', key)

  // Always scope to org if we have it — Rule #1
  if (organizationId) {
    query = (query as any).eq('organization_id', organizationId)
  }

  const { count, error } = await (query as any)
  if (error) throw new Error(`[event-log-repo] existsByIdempotencyKey failed: ${error.message}`)
  return (count ?? 0) > 0
}
