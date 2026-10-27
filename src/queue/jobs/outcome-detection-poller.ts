/**
 * outcome-detection-poller.ts — Salesforce Event polling for meeting detection.
 *
 * Runs on a configurable interval (OUTCOME_POLL_INTERVAL_MS, default 10 min).
 * Mirrors sla-timer.ts structure exactly: per-org isolation, immutable event_log,
 * update play_instance mutable projection after writing events.
 *
 * Non-negotiables enforced here:
 * - No hardcoded values (meeting types, attribution days, SF field names from policy)
 * - event_log is append-only — never UPDATE
 * - organization_id on every query
 * - Duplicate SF Event → no duplicate outcome_signal (UNIQUE constraint + pre-check)
 * - One org's ConnectorError never crashes other orgs' polling loop
 * - attribution_window_days read from play_instance.attribution_window_days,
 *   NEVER re-read from policy at poll time (captured at play start)
 */

import { getDb } from '../../db/client.js'
import { writeEvent } from '../../events/event-log.js'
import { loadOutcomeDetectionConfig, OutcomeDetectionConfigMissingError } from '../../policies/outcome-detection.js'
import { SalesforceConnector } from '../../connectors/salesforce/salesforce.connector.js'
import { getConnectors } from '../../connectors/factory.js'
import {
  queryMeetingEvents,
  queryLeadStatus,
  queryOpportunityStage,
  queryCustomCheckbox,
} from '../../connectors/salesforce/events.js'
import { ConnectorError } from '../../connectors/base.js'
import type { DecisionSnapshot } from '../../domain/db-types.js'

// ── Entry point — mirrors runSlaTimer ─────────────────────────────────────────

export async function runOutcomeDetectionPoller(organizationIds: string[]): Promise<void> {
  for (const orgId of organizationIds) {
    try {
      await pollOrgForMeetings(orgId)
    } catch (err) {
      // Per-org isolation: one org's failure never blocks others
      console.error(`[outcome-poller] Org ${orgId} failed: ${err}`)
    }
  }
}

// ── Per-org logic ─────────────────────────────────────────────────────────────

async function pollOrgForMeetings(orgId: string): Promise<void> {
  // ── 1. Load outcome detection config — fail fast if not configured ──────────
  let config: Awaited<ReturnType<typeof loadOutcomeDetectionConfig>>
  try {
    config = await loadOutcomeDetectionConfig(orgId)
  } catch (err) {
    if (err instanceof OutcomeDetectionConfigMissingError) {
      // Not an error — org just hasn't configured outcome detection yet
      console.warn(`[outcome-poller] Org ${orgId}: no outcome_detection policy configured — skipping`)
      return
    }
    throw err
  }

  // ── 2. Workspace's Salesforce (encrypted per-org credentials) ─────────────
  let sf: SalesforceConnector | null
  try {
    sf = await getConnectors(orgId).salesforce()
  } catch (connErr) {
    console.error(`[outcome-poller] Org ${orgId}: Salesforce connect failed: ${connErr}`)
    return
  }
  if (!sf) {
    console.warn(`[outcome-poller] Org ${orgId}: Salesforce is not connected — skipping meeting detection`)
    return
  }

  // ── 3. Load plays awaiting outcome ─────────────────────────────────────────
  // Reads attribution_window_days from play_instance (captured at play start)
  const { data: plays, error: playsErr } = await getDb()
    .from('play_instance')
    .select('id, lead_id, created_at, outcome_status, attribution_window_days')
    .eq('organization_id', orgId)
    .eq('outcome_status', 'no_outcome_yet')
    .in('status', ['running', 'completed'])

  if (playsErr) {
    console.error(`[outcome-poller] Org ${orgId}: failed to query plays: ${playsErr.message}`)
    return
  }

  for (const play of plays ?? []) {
    await processPlayForOutcome(orgId, play, sf, config)
  }
}

// ── Per-play detection logic ──────────────────────────────────────────────────

async function processPlayForOutcome(
  orgId: string,
  play: {
    id: string
    lead_id: string
    created_at: string
    outcome_status: string
    attribution_window_days: number
  },
  sf: SalesforceConnector,
  config: Awaited<ReturnType<typeof loadOutcomeDetectionConfig>>
): Promise<void> {
  const windowStart = new Date(play.created_at)
  const windowEnd   = new Date(
    windowStart.getTime() + play.attribution_window_days * 24 * 60 * 60 * 1000
  )

  // Look up SF WhoId for this lead via external_identity
  const { data: identity } = await getDb()
    .from('external_identity')
    .select('external_id')
    .eq('organization_id', orgId)
    .eq('entity_id', play.lead_id)
    .eq('provider', 'salesforce')
    .eq('entity_type', 'lead')
    .single()

  if (!identity?.external_id) {
    // Lead not in SF yet — skip silently (SF sync may be pending)
    return
  }

  const sfLeadId = identity.external_id

  // ── Query primary signals ──────────────────────────────────────────────────
  let sfEvents: Awaited<ReturnType<typeof queryMeetingEvents>>
  try {
    sfEvents = await queryMeetingEvents(sf, sfLeadId, config.primaryMeetingTypes, windowStart, windowEnd)
  } catch (err) {
    if (err instanceof ConnectorError) {
      console.error(`[outcome-poller] Org ${orgId} / play ${play.id}: SF Event query failed: ${err.message}`)
      return  // do not crash other plays
    }
    throw err
  }

  if (sfEvents.length > 0) {
    await handlePrimarySignals(orgId, play, sfEvents)
    return  // primary signals found — skip supportive check
  }

  // ── Query supportive signals (informational only, never change outcome_status) ─
  await handleSupportiveSignals(orgId, play, sfLeadId, sf, config)
}

// ── Primary signal handler ────────────────────────────────────────────────────

async function handlePrimarySignals(
  orgId: string,
  play: { id: string; lead_id: string; outcome_status: string },
  sfEvents: Awaited<ReturnType<typeof queryMeetingEvents>>
): Promise<void> {
  // Load current play state fresh (outcome_status may have changed since batch load)
  const { data: freshPlay } = await getDb()
    .from('play_instance')
    .select('outcome_status, meetings_count_in_window')
    .eq('id', play.id)
    .eq('organization_id', orgId)
    .single()

  const currentStatus = freshPlay?.outcome_status ?? play.outcome_status

  for (const event of sfEvents) {
    // Idempotency: check before insert (UNIQUE constraint is the hard guard;
    // this pre-check avoids throwing on every re-poll)
    const { data: existing } = await getDb()
      .from('outcome_signal')
      .select('id')
      .eq('organization_id', orgId)
      .eq('play_instance_id', play.id)
      .eq('external_event_id', event.Id)
      .single()

    if (existing) continue  // already recorded — skip

    // Write outcome_signal row (append-only)
    const { error: sigErr } = await getDb()
      .from('outcome_signal')
      .insert({
        organization_id:  orgId,
        play_instance_id: play.id,
        lead_id:          play.lead_id,
        signal_type:      'sf_event_meeting',
        confidence:       'primary',
        external_event_id: event.Id,
        sf_raw_payload:   event as unknown as Record<string, unknown>,
      })

    if (sigErr) {
      // If UNIQUE violation — another poller instance wrote it first, skip silently
      if (sigErr.code === '23505') continue
      console.error(`[outcome-poller] Failed to insert outcome_signal: ${sigErr.message}`)
      continue
    }

    // Build minimal decision snapshot for event_log (poller context)
    const snapshot: DecisionSnapshot = {
      lead:           { id: play.lead_id } as any,
      company:        null,
      policies:       [],
      ownerWorkloads: {},
      evidenceIds:    [],
      agentName:      'outcome-poller',
      agentVersion:   '1.0.0',
      promptVersion:  null,
      modelName:      null,
    }

    if (currentStatus === 'no_outcome_yet') {
      // First primary signal — flip to meeting_booked
      await writeEvent({
        organizationId:   orgId,
        workflowRunId:    play.id,
        playInstanceId:   play.id,
        leadId:           play.lead_id,
        eventType:        'outcome_detected',
        actorType:        'outcome_poller',
        externalSystem:   'salesforce',
        externalId:       event.Id,
        eventStatus:      'success',
        decisionSnapshot: snapshot,
      })

      await getDb()
        .from('play_instance')
        .update({
          outcome_status:       'meeting_booked',
          outcome_detected_at:  new Date().toISOString(),
          meetings_count_in_window: 1,
          updated_at:           new Date().toISOString(),
        })
        .eq('id', play.id)
        .eq('organization_id', orgId)

    } else if (currentStatus === 'meeting_booked') {
      // Additional primary signal — increment count, no duplicate event_log entry
      await getDb()
        .from('play_instance')
        .update({
          meetings_count_in_window: (freshPlay?.meetings_count_in_window ?? 1) + 1,
          updated_at:               new Date().toISOString(),
        })
        .eq('id', play.id)
        .eq('organization_id', orgId)

    } else if (currentStatus === 'no_meeting') {
      // Primary signal arrived after the hard cutoff — late meeting
      await writeEvent({
        organizationId:   orgId,
        workflowRunId:    play.id,
        playInstanceId:   play.id,
        leadId:           play.lead_id,
        eventType:        'late_meeting_detected',
        actorType:        'outcome_poller',
        externalSystem:   'salesforce',
        externalId:       event.Id,
        eventStatus:      'success',
        decisionSnapshot: snapshot,
      })

      await getDb()
        .from('play_instance')
        .update({
          late_meeting_flag: true,
          updated_at:        new Date().toISOString(),
        })
        .eq('id', play.id)
        .eq('organization_id', orgId)
      // outcome_status remains 'no_meeting' — hard cutoff is permanent
    }
  }
}

// ── Supportive signal handler ─────────────────────────────────────────────────
// Supportive signals are informational only.
// They NEVER change outcome_status. They are recorded for context/replay.

async function handleSupportiveSignals(
  orgId: string,
  play: { id: string; lead_id: string },
  sfLeadId: string,
  sf: SalesforceConnector,
  config: Awaited<ReturnType<typeof loadOutcomeDetectionConfig>>
): Promise<void> {
  const signalsToWrite: Array<{
    signal_type: 'lead_status' | 'meeting_checkbox' | 'opportunity_stage'
    external_event_id: string
    sf_raw_payload: Record<string, unknown>
  }> = []

  // ── Lead status check ──────────────────────────────────────────────────────
  if (config.supportiveLeadStatuses.length > 0) {
    try {
      const status = await queryLeadStatus(sf, sfLeadId)
      if (status && config.supportiveLeadStatuses.includes(status)) {
        signalsToWrite.push({
          signal_type:       'lead_status',
          external_event_id: `${sfLeadId}:status:${status}`,
          sf_raw_payload:    { leadId: sfLeadId, status },
        })
      }
    } catch (err) {
      console.error(`[outcome-poller] Lead status query failed for ${sfLeadId}: ${err}`)
    }
  }

  // ── Custom checkbox check ──────────────────────────────────────────────────
  if (config.supportiveCheckboxField) {
    try {
      const checked = await queryCustomCheckbox(sf, sfLeadId, config.supportiveCheckboxField)
      if (checked === true) {
        signalsToWrite.push({
          signal_type:       'meeting_checkbox',
          external_event_id: `${sfLeadId}:checkbox:${config.supportiveCheckboxField}`,
          sf_raw_payload:    { leadId: sfLeadId, field: config.supportiveCheckboxField, value: true },
        })
      }
    } catch (err) {
      console.error(`[outcome-poller] Custom checkbox query failed for ${sfLeadId}: ${err}`)
    }
  }

  // Write each supportive signal if not already recorded (idempotency via UNIQUE)
  for (const sig of signalsToWrite) {
    const { data: existing } = await getDb()
      .from('outcome_signal')
      .select('id')
      .eq('organization_id', orgId)
      .eq('play_instance_id', play.id)
      .eq('external_event_id', sig.external_event_id)
      .single()

    if (existing) continue

    const { error } = await getDb()
      .from('outcome_signal')
      .insert({
        organization_id:   orgId,
        play_instance_id:  play.id,
        lead_id:           play.lead_id,
        signal_type:       sig.signal_type,
        confidence:        'supportive',
        external_event_id: sig.external_event_id,
        sf_raw_payload:    sig.sf_raw_payload,
      })

    if (error && error.code !== '23505') {
      console.error(`[outcome-poller] Failed to insert supportive signal: ${error.message}`)
    }
    // outcome_status is never modified by supportive signals
  }
}
