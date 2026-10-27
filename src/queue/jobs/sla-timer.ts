/**
 * sla-timer.ts — 2-minute SLA heartbeat job.
 *
 * Logic:
 * 1. Find plays where sla_breached = FALSE, status = 'running',
 *    first_touch_at IS NULL, and first_touch_deadline < NOW()
 * 2. Write sla_breached event, mark play as breached, enqueue escalation
 *
 * SLA deadline MUST use form_submitted_at, not created_at.
 * first_touch_deadline is set at play creation time as form_submitted_at + policy_minutes
 * and is therefore always correct — no re-verification needed at breach time.
 *
 * MVP scope: follow-up sequencing is handled by Outreach enrolled sequences.
 * Multi-touch follow-up scheduling (next_action_at, current_step text patterns)
 * is out of scope for MVP and will be added in a future milestone.
 */

import { getDb } from '../../db/client.js'
import { writeEvent } from '../../events/event-log.js'
import { addJob } from '../setup.js'


export async function runSlaTimer(organizationIds: string[]): Promise<void> {
  // ── Guard: fail loudly if org list is empty ───────────────────────────────
  // An empty list means no SLA enforcement runs — this is always a misconfiguration.
  // start-workers.ts should always pass at least one org via ACTIVE_ORG_IDS or DB query.
  if (organizationIds.length === 0) {
    console.error(
      '[sla-timer] CRITICAL: called with zero organization IDs — no SLA checks will run. ' +
      'Ensure ACTIVE_ORG_IDS is set, or that active orgs exist in the organizations table. ' +
      'This is a misconfiguration, not a transient error.'
    )
    return
  }

  console.log(`[sla-timer] Checking SLA for ${organizationIds.length} org(s): ${organizationIds.join(', ')}`)
  let totalBreached = 0

  for (const orgId of organizationIds) {
    const breachedCount = await checkBreachedPlays(orgId)
    totalBreached += breachedCount
  }

  console.log(`[sla-timer] Run complete — orgs checked: ${organizationIds.length}, plays breached this run: ${totalBreached}`)
}

async function checkBreachedPlays(orgId: string): Promise<number> {
  // Select only columns that exist on play_instance (schema: migration 008).
  // first_touch_deadline already encodes the absolute deadline — no sla_minutes needed.
  const { data: breached, error } = await getDb()
    .from('play_instance')
    .select('id, lead_id, first_touch_deadline, created_at')
    .eq('organization_id', orgId)
    .eq('status', 'running')
    .is('first_touch_at', null)
    .eq('sla_breached', false)
    .is('removed_at', null)   // removed test leads (migration 031) are no longer watched
    .lt('first_touch_deadline', new Date().toISOString())

  if (error) {
    console.error(`[sla-timer] Failed to query breached plays for org ${orgId}: ${error.message}`)
    return 0
  }

  const plays = breached ?? []
  if (plays.length > 0) {
    console.log(`[sla-timer] Org ${orgId}: ${plays.length} play(s) breached SLA`)
  }

  for (const play of plays) {
    // ── 1. Write sla_breached event ──────────────────────────────────────────
    try {
      await writeEvent({
        organizationId:   orgId,
        workflowRunId:    play.id,
        playInstanceId:   play.id,
        leadId:           play.lead_id,
        eventType:        'sla_breached',
        actorType:        'sla_timer',
        eventStatus:      'success',
        decisionSnapshot: {
          lead:          { id: play.lead_id } as any,
          company:       null,
          policies:      [],
          ownerWorkloads: {},
          evidenceIds:   [],
          agentName:     'sla-timer',
          agentVersion:  '1.0.0',
          promptVersion: null,
          modelName:     null,
        },
      })
    } catch (err) {
      console.error(`[sla-timer] Failed to write sla_breached event for play ${play.id}: ${err}`)
    }

    // ── 2. Mark play as breached ─────────────────────────────────────────────
    await getDb()
      .from('play_instance')
      .update({ sla_breached: true, sla_breached_at: new Date().toISOString() })
      .eq('id', play.id)
      .eq('organization_id', orgId)

    // ── 3. Enqueue escalation at priority 1 ───────────────────────────────────
    await addJob('escalate-play', { playId: play.id, organizationId: orgId, reason: 'SLA_BREACHED' }, { priority: 1 })
  }

  return plays.length
}
