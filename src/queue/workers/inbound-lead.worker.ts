/**
 * inbound-lead.worker.ts — Processes HubSpot form submission payloads.
 * Creates lead + play_instance records, emits webhook_received, runs LangGraph play.
 *
 * CRITICAL RULES:
 * - organization_id must be a valid UUID — never use portalId directly
 * - play_instance.current_step is INTEGER (not string)
 * - play_instance.first_touch_deadline = form_submitted_at + sla_minutes (never created_at)
 */

import { Worker } from 'bullmq'
import { getConnectors } from '../../connectors/factory.js'
import { findOrgByHubspotPortal } from '../../repositories/connector-credentials.repository.js'
import { getDb } from '../../db/client.js'
import { findExistingRun } from './inbound-run.js'
import { writeEvent } from '../../events/event-log.js'
import { redisConnection } from '../setup.js'
import { runInboundLeadPlay } from '../../workflows/inbound-lead/graph.js'

const DEFAULT_SLA_MINUTES = 15

/**
 * Resolve HubSpot portalId → organization UUID.
 * Looks up the org by matching portalId stored in connector_config.
 *
 * If no match is found, throws a descriptive error — the operator must configure
 * connector_config with { portal_id: "<portalId>" } for the HubSpot connector.
 * There is no DEFAULT_ORG_ID fallback: a missing mapping is a misconfiguration,
 * not a recoverable state. Failing here causes BullMQ to retry (with backoff),
 * which is the correct behaviour during a configuration race on first deploy.
 */
async function resolveOrganizationId(jobOrgId: string | undefined, portalId: number | string | undefined): Promise<string> {
  // Webhook route resolved the workspace from the verified portal signature.
  if (jobOrgId) return jobOrgId
  // Jobs enqueued before this change: resolve the same way, from the portal.
  if (portalId) {
    const orgId = await findOrgByHubspotPortal(String(portalId))
    if (orgId) return orgId
  }
  throw new Error(
    `[inbound-lead-worker] No workspace has HubSpot portal ${portalId} connected. ` +
    `Connect HubSpot for this portal on the Connections page.`
  )
}

/**
 * Load SLA minutes from the organization's active SLA policy rule.
 * Defaults to DEFAULT_SLA_MINUTES (15) if no rule found.
 */
async function loadSlaMins(organizationId: string): Promise<number> {
  const db = getDb()
  const { data } = await db
    .from('policy_rules')
    .select('actions')
    .eq('organization_id', organizationId)
    .eq('rule_type', 'sla')
    .eq('is_active', true)
    .order('priority', { ascending: true })
    .limit(1)
    .single()

  const slaMinutes = (data?.actions as any)?.sla_minutes
  return typeof slaMinutes === 'number' && slaMinutes > 0 ? slaMinutes : DEFAULT_SLA_MINUTES
}

/**
 * Load attribution_window_days from the org's active outcome_detection policy rule.
 * This value is captured ONCE at play creation time and stored on play_instance.
 * The poller always reads it from play_instance.attribution_window_days — never
 * re-reads from policy after the play is started. Policy changes after the fact
 * have zero effect on in-flight plays (GEMINI.md non-negotiable).
 *
 * Defaults to 14 if no outcome_detection policy configured — play creation
 * must not fail just because outcome tracking isn't yet set up for this org.
 */
async function loadAttributionWindowDays(organizationId: string): Promise<number> {
  const db = getDb()
  const { data } = await db
    .from('policy_rules')
    .select('conditions')
    .eq('organization_id', organizationId)
    .eq('rule_type', 'outcome_detection')
    .eq('is_active', true)
    .order('priority', { ascending: false })
    .limit(1)
    .single()

  const days = (data?.conditions as any)?.attribution_window_days
  return typeof days === 'number' && days > 0 ? days : 14
}

export const inboundLeadWorker = new Worker(
  'inbound-lead-processing',
  async (job) => {
    const { payload, idempotencyKey, organizationId: jobOrgId } = job.data
    // Test leads come from POST /api/test-lead (setup page), never from the webhook.
    const testLead: { requestedBy: string } | null =
      job.data.isTest === true && typeof job.data.requestedBy === 'string' ? { requestedBy: job.data.requestedBy } : null
    let workflowRunId = job.id!

    try {
      // ── Resolve organization UUID from HubSpot portalId ──────────────────────
      const orgId = await resolveOrganizationId(jobOrgId, payload.portalId)
      const db = getDb()

      // ── Parse form submission timestamp ──────────────────────────────────────
      const formSubmittedAt = payload.occurredAt
        ? new Date(payload.occurredAt).toISOString()
        : new Date().toISOString()

      // ── Load SLA minutes + attribution window for this org ────────────────────
      const slaMinutes = await loadSlaMins(orgId)
      const attributionWindowDays = await loadAttributionWindowDays(orgId)
      const firstTouchDeadline = new Date(
        new Date(formSubmittedAt).getTime() + slaMinutes * 60_000
      ).toISOString()

      // ── Resolve contact properties ─────────────────────────────────────────
      // Real HubSpot webhooks only contain objectId — no email/name.
      // Fetch full contact from HubSpot API when properties are missing.
      let properties = payload.properties ?? {}
      if (!properties.email && payload.objectId) {
        const hs = await getConnectors(orgId).hubspot()
        if (!hs) {
          // Never silently default: without HubSpot credentials we cannot read the contact.
          throw new Error(`[inbound-lead-worker] HubSpot is not connected for workspace ${orgId} — cannot fetch contact ${payload.objectId}`)
        }
        const contact = await hs.getContactById(payload.objectId)
        if (contact?.properties) {
          properties = contact.properties
        } else {
          console.warn(`[inbound-lead-worker] Contact ${payload.objectId} not found in HubSpot (404 or deleted) — skipping job`)
          return
        }
      }

      // Guard: email is required to create a lead
      if (!properties.email) {
        console.warn(`[inbound-lead-worker] Contact ${payload.objectId} has no email — skipping job (HubSpot contacts require email)`)
        return
      }

      // ── Retry safety: continue what an earlier attempt of this job created ───
      // One source event → one lead + one play. See inbound-run.ts.
      const existing = await findExistingRun(db, orgId, payload.eventId)
      let lead: { id: string }
      let play: { id: string }
      let writeWebhookEvent = true
      if (existing?.playInstanceId && existing.workflowRunId) {
        lead = { id: existing.leadId }
        play = { id: existing.playInstanceId }
        workflowRunId = existing.workflowRunId
        writeWebhookEvent = !existing.webhookEventWritten
        console.warn(`[inbound-lead-worker] Job ${job.id} is a retry of run ${workflowRunId} (lead ${lead.id}) — continuing it, not creating a new lead`)
      } else {
      if (existing) {
        // Lead was inserted but the play was not: reuse the lead, create only the play.
        lead = { id: existing.leadId }
      } else {
      // ── Create lead record ────────────────────────────────────────────────────
      const { data: newLead, error: leadErr } = await db
        .from('leads')
        .insert({
          organization_id:  orgId,
          email:            properties.email ?? payload.email,
          first_name:       properties.firstname ?? null,
          last_name:        properties.lastname ?? null,
          title:            properties.jobtitle ?? null,
          phone:            properties.phone ?? null,
          source:           testLead ? 'setup:test_lead' : `hubspot:${payload.subscriptionType ?? 'form'}`,
          stage:            'new',
          form_submitted_at: formSubmittedAt,
          raw_payload:      payload,
          is_test:          testLead !== null,
          // Qualification fields start null — set by QualificationAgent
          is_duplicate:     false,
          is_icp_fit:       null,
          icp_score:        null,
          icp_tier:         null,
        })
        .select('id')
        .single()

      if (leadErr) throw new Error(`Failed to create lead: ${leadErr.message}`)
      lead = newLead

      }
      // ── Create play_instance ─────────────────────────────────────────────────
      const { data: newPlay, error: playErr } = await db
        .from('play_instance')
        .insert({
          organization_id:    orgId,
          lead_id:            lead.id,
          status:             'running',
          current_step:       0,                // INTEGER — not a string
          workflow_run_id:    workflowRunId,
          // SLA deadline: form_submitted_at + sla_minutes (NEVER created_at)
          first_touch_deadline: firstTouchDeadline,
          // Attribution window captured at play start — IMMUTABLE after creation.
          // Poller always reads this value from play_instance, never from policy.
          attribution_window_days: attributionWindowDays,
          is_test:            testLead !== null,
        })
        .select('id')
        .single()

      if (playErr) throw new Error(`Failed to create play_instance: ${playErr.message}`)
      play = newPlay

      }

      // ── Emit webhook_received event ──────────────────────────────────────────
      if (writeWebhookEvent) await writeEvent({
        organizationId:   orgId,
        workflowRunId,
        playInstanceId:   play.id,
        leadId:           lead.id,
        eventType:        'webhook_received',
        // A test lead was sent by an admin from the setup page, not by HubSpot.
        actorType:        testLead ? 'human' : 'webhook',
        ...(testLead ? { actorId: testLead.requestedBy } : {}),
        idempotencyKey,
        eventStatus:      'success',
        decisionSnapshot: {
          lead:         { id: lead.id } as any,
          company:      null,
          policies:     [],
          ownerWorkloads: {},
          evidenceIds:  [],
          agentName:    'inbound-lead-worker',
          agentVersion: '1.0.0',
          promptVersion: null,
          modelName:    null,
        },
      })

      // ── Run the inbound-lead play via LangGraph ──────────────────────────────
      // Pass the real DB IDs so the graph does NOT generate synthetic ones
      const result = await runInboundLeadPlay(orgId, {
        ...payload,
        _leadId:          lead.id,
        _playInstanceId:  play.id,
        _workflowRunId:   workflowRunId,
      })

      if (result.status === 'paused') {
        console.log(`[inbound-lead-worker] Play ${result.playInstanceId} paused for human review (checkpoint saved)`)
      } else if (result.status === 'completed' || result.status === 'running') {
        console.log(`[inbound-lead-worker] Play ${result.playInstanceId} status: ${result.status}`)
      } else {
        console.error(`[inbound-lead-worker] Play ended with status: ${result.status}`)
      }

    } catch (err) {
      console.error(`[inbound-lead-worker] Job ${job.id} failed: ${err}`)
      throw err  // BullMQ retries
    }
  },
  { connection: redisConnection, concurrency: 5 }
)
