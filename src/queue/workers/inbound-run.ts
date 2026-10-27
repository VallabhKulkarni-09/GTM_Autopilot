/**
 * inbound-run.ts — makes the inbound-lead job safe to retry.
 *
 * Found live: a transient DB/DNS error after the lead row was inserted made BullMQ retry the
 * job; the retry inserted a SECOND lead for the same HubSpot event, whose dedup check then found
 * the first one and marked the real lead a duplicate of itself.
 *
 * Rule: one source event (payload.eventId) → at most one lead + one play per workspace.
 * A retry finds what the earlier attempt created and continues with the SAME workflowRunId, so
 * every action idempotency key (`${orgId}:${workflowRunId}:${actionId}`) stays stable and no
 * external call is repeated.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type ExistingRun = {
  leadId: string
  playInstanceId: string | null
  workflowRunId: string | null
  webhookEventWritten: boolean
}

/** What an earlier attempt of this job already created, or null on a first attempt. */
export async function findExistingRun(
  db: SupabaseClient,
  organizationId: string,
  sourceEventId: string | number | undefined,
): Promise<ExistingRun | null> {
  if (sourceEventId === undefined || sourceEventId === null || sourceEventId === '') return null

  const { data: leads, error: leadErr } = await db
    .from('leads')
    .select('id')
    .eq('organization_id', organizationId)
    .contains('raw_payload', { eventId: sourceEventId })
    .order('created_at', { ascending: true })
    .limit(1)
  if (leadErr) throw new Error(`findExistingRun: lead lookup failed: ${leadErr.message}`)
  const lead = leads?.[0]
  if (!lead) return null

  const { data: play, error: playErr } = await db
    .from('play_instance')
    .select('id, workflow_run_id')
    .eq('organization_id', organizationId)
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (playErr) throw new Error(`findExistingRun: play lookup failed: ${playErr.message}`)

  let webhookEventWritten = false
  if (play) {
    const { count, error: evErr } = await db
      .from('event_log')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('play_instance_id', play.id)
      .eq('event_type', 'webhook_received')
    if (evErr) throw new Error(`findExistingRun: event lookup failed: ${evErr.message}`)
    webhookEventWritten = (count ?? 0) > 0
  }

  return {
    leadId: lead.id as string,
    playInstanceId: (play?.id as string | undefined) ?? null,
    workflowRunId: (play?.workflow_run_id as string | undefined) ?? null,
    webhookEventWritten,
  }
}
