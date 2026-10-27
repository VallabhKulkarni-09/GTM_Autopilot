/**
 * outcome-window-closer.ts — Attribution window expiry job.
 *
 * Runs on a configurable interval (OUTCOME_WINDOW_CLOSE_INTERVAL_MS, default 1 hour).
 * Mirrors sla-timer.ts structure.
 *
 * This is the ONLY job that transitions play_instance to 'no_meeting'.
 * The detection poller NEVER sets no_meeting — only this job does.
 *
 * Guard: only touches plays where outcome_status = 'no_outcome_yet'.
 * Plays already 'meeting_booked' or 'no_meeting' are invisible to this query.
 *
 * attribution_window_days is read from play_instance.attribution_window_days —
 * the value captured at play creation. Org policy changes after the fact have
 * no effect on in-flight plays (non-negotiable, per spec).
 */

import { getDb } from '../../db/client.js'
import { writeEvent } from '../../events/event-log.js'
import type { DecisionSnapshot } from '../../domain/db-types.js'

// ── Entry point — mirrors runSlaTimer ─────────────────────────────────────────

export async function runOutcomeWindowCloser(organizationIds: string[]): Promise<void> {
  for (const orgId of organizationIds) {
    try {
      await closeExpiredWindows(orgId)
    } catch (err) {
      // Per-org isolation
      console.error(`[outcome-window-closer] Org ${orgId} failed: ${err}`)
    }
  }
}

// ── Per-org logic ─────────────────────────────────────────────────────────────

async function closeExpiredWindows(orgId: string): Promise<void> {
  // Find plays where:
  // - outcome_status = 'no_outcome_yet' (only these can be closed)
  // - now() > created_at + attribution_window_days
  // We filter in code after fetching, since Supabase JS doesn't support
  // interval arithmetic in .filter(). The index on (org, outcome_status)
  // keeps this efficient.
  const { data: plays, error } = await getDb()
    .from('play_instance')
    .select('id, lead_id, created_at, attribution_window_days')
    .eq('organization_id', orgId)
    .eq('outcome_status', 'no_outcome_yet')

  if (error) {
    console.error(`[outcome-window-closer] Org ${orgId}: query failed: ${error.message}`)
    return
  }

  const now = Date.now()

  for (const play of plays ?? []) {
    const windowEndMs =
      new Date(play.created_at).getTime() +
      play.attribution_window_days * 24 * 60 * 60 * 1000

    if (now <= windowEndMs) continue  // window still open — skip

    await closePlay(orgId, play)
  }
}

async function closePlay(
  orgId: string,
  play: { id: string; lead_id: string; created_at: string; attribution_window_days: number }
): Promise<void> {
  const snapshot: DecisionSnapshot = {
    lead:           { id: play.lead_id } as any,
    company:        null,
    policies:       [],
    ownerWorkloads: {},
    evidenceIds:    [],
    agentName:      'outcome-window-closer',
    agentVersion:   '1.0.0',
    promptVersion:  null,
    modelName:      null,
  }

  // ── 1. Write outcome_window_closed event FIRST (append-only) ───────────────
  try {
    await writeEvent({
      organizationId:   orgId,
      workflowRunId:    play.id,
      playInstanceId:   play.id,
      leadId:           play.lead_id,
      eventType:        'outcome_window_closed',
      actorType:        'outcome_poller',
      eventStatus:      'success',
      decisionSnapshot: snapshot,
    })
  } catch (err) {
    console.error(`[outcome-window-closer] Failed to write event for play ${play.id}: ${err}`)
    return  // do not update play_instance if event write failed (consistency)
  }

  // ── 2. Flip outcome_status to 'no_meeting' ─────────────────────────────────
  // The WHERE clause double-checks outcome_status = 'no_outcome_yet' to guard
  // against a race condition where the poller and this job run concurrently.
  const { error: updateErr } = await getDb()
    .from('play_instance')
    .update({
      outcome_status: 'no_meeting',
      updated_at:     new Date().toISOString(),
    })
    .eq('id', play.id)
    .eq('organization_id', orgId)
    .eq('outcome_status', 'no_outcome_yet')  // idempotency guard

  if (updateErr) {
    console.error(`[outcome-window-closer] Failed to update play ${play.id}: ${updateErr.message}`)
  }
}
