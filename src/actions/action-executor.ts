/**
 * action-executor.ts
 * The ONLY place in the system that calls connectors.
 * No other file may call a connector directly.
 *
 * Pipeline (executeAction):
 *   1. Check idempotency — deduplicate if already executed
 *   2. Emit action_execution_started
 *   3. Execute action (connector call or DB mutation)
 *   4. Emit action_execution_succeeded (or action_execution_failed)
 *
 * CRITICAL: Steps 2 and 4 are ALWAYS written to event_log.
 * Use try/finally to guarantee this even when step 3 throws.
 */

import { getDb } from '../db/client.js'
import { writeEvent } from '../events/event-log.js'
import type { ProposedAction, ActionExecutionResult, DecisionSnapshot } from './types.js'
import { ConnectorError } from '../connectors/base.js'
import type { ConnectorName, ReviewContext, ReviewKind } from '../domain/db-types.js'

// ─── Connector registry type ──────────────────────────────────────────────────

export type ConnectorRegistry = {
  salesforce: {
    assignLeadOwner(leadId: string, ownerId: string, idempotencyKey: string): Promise<void>
    createTask(leadId: string, task: { subject: string; description?: string; due_date: string; ownerId?: string }, idempotencyKey: string): Promise<{ Id: string }>
    createLead(data: { firstName?: string; lastName: string; email: string; title?: string; phone?: string; company?: string; leadSource?: string }, idempotencyKey: string): Promise<{ Id: string }>
    findLeadByEmail(email: string): Promise<{ Id: string } | null>
  }
  hubspot: unknown
  outreach: {
    getProspectByEmail(email: string): Promise<{ id: string } | null>
    createProspect(input: { email: string; firstName?: string; lastName?: string; title?: string }, idempotencyKey: string): Promise<{ id: string }>
    enrollInSequence(prospectId: string, sequenceId: string, idempotencyKey: string): Promise<{ id: string }>
  }
  salesloft: {
    getPersonByEmail(email: string): Promise<{ id: number } | null>
    createPerson(input: { email_address: string; first_name?: string; last_name?: string; title?: string }, idempotencyKey: string): Promise<{ id: number }>
    enrollInCadence(personId: number, cadenceId: number, idempotencyKey: string): Promise<{ id: number }>
  }
  apollo: {
    findContactByEmail(email: string): Promise<{ id: string; sequenceIds: string[] } | null>
    createContact(input: { email: string; firstName?: string; lastName?: string; title?: string; organizationName?: string; websiteUrl?: string }, idempotencyKey: string): Promise<{ id: string; sequenceIds: string[] }>
    addContactToSequence(contactId: string, sequenceId: string, emailAccountId: string, idempotencyKey: string): Promise<{ contactId: string; sequenceId: string; campaignStatusId: string | null }>
  }
  clearbit: unknown
  zoominfo: unknown
}

/** start_sequence parameters built by first-touch from the outreach policy (v1: Apollo only). */
export type ApolloStartSequenceParams = {
  provider:                 'apollo'
  plan:                     'enroll' | 'manual' | 'not_configured'
  tier:                     string | null
  outreach_policy_id:       string | null   // null only when the policy is missing (plan = not_configured)
  outreach_policy_version:  number | null
  apollo_sequence_id?:      string
  apollo_sequence_name?:    string
  apollo_email_account_id?: string
  reason_code?:             string   // manual: why no sequence; not_configured: what is missing
  reason_message?:          string
}

/** Apollo failures a retry cannot fix: a human must act. */
const NON_RETRYABLE_STATUS = new Set([200, 400, 401, 403, 404, 422])

// ─── Idempotency check ────────────────────────────────────────────────────────

/**
 * True only when this exact action already SUCCEEDED in this org.
 * Reads event_log (append-only source of truth), not the action_execution_state projection:
 * found live, agent-proposed actions had no projection row, so the projection never reached
 * 'succeeded' and a job retry repeated Salesforce calls (3 Tasks for one lead).
 * A started or failed attempt must not block a retry.
 */
async function existsByIdempotencyKey(organizationId: string, key: string): Promise<boolean> {
  const { count, error } = await getDb()
    .from('event_log')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('idempotency_key', key)
    .eq('event_type', 'action_execution_succeeded')
  // Never silently allow a possible duplicate external call.
  if (error) throw new Error(`[action-executor] idempotency check failed: ${error.message}`)
  return (count ?? 0) > 0
}
// ─── Repository helpers ───────────────────────────────────────────────────────

async function updateLead(
  leadId: string,
  organizationId: string,
  data: Record<string, unknown>
): Promise<void> {
  const { error } = await getDb()
    .from('leads')
    .update(data)
    .eq('id', leadId)
    .eq('organization_id', organizationId)
  if (error) throw new Error(`[action-executor] updateLead failed: ${error.message}`)
}

async function updatePlayInstance(
  playInstanceId: string,
  organizationId: string,
  data: Record<string, unknown>
): Promise<void> {
  const { error } = await getDb()
    .from('play_instance')
    .update(data)
    .eq('id', playInstanceId)
    .eq('organization_id', organizationId)
  if (error) throw new Error(`[action-executor] updatePlayInstance failed: ${error.message}`)
}

async function incrementRoutingStateIndex(
  organizationId: string,
  queueName: string
): Promise<void> {
  // Increment counter in routing_state for the queue (round-robin advance)
  const { data } = await getDb()
    .from('routing_state')
    .select('id, counter')
    .eq('organization_id', organizationId)
    .eq('queue_name', queueName)
    .single()
  if (!data) return

  await getDb()
    .from('routing_state')
    .update({ counter: (data.counter ?? 0) + 1 })
    .eq('id', data.id)
    .eq('organization_id', organizationId)
}

// ─── Briefing card builder ────────────────────────────────────────────────────

function buildBriefingCard(
  lead: { first_name?: string | null; last_name?: string | null; title?: string | null; email: string; form_submitted_at: string },
  company: { name?: string | null; employee_count?: number | null; annual_revenue?: number | null; industry?: string | null } | null,
  evidence: Array<{ source_type?: string; data?: Record<string, unknown> }>,
  rawPayload: Record<string, unknown> | null
): string {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email
  const minutesAgo = Math.round((Date.now() - new Date(lead.form_submitted_at).getTime()) / 60000)

  // Extract tech stack from evidence
  const techEvidence = evidence.find(e => e.source_type === 'clearbit_enrichment')
  const techStack: string[] = (techEvidence?.data?.tech as string[] | undefined) ?? []
  const techLine = techStack.length > 0 ? techStack.slice(0, 5).join(', ') : 'Unknown'

  // Extract form comment
  const comment = (rawPayload?.message ?? rawPayload?.comment ?? rawPayload?.use_case ?? '') as string

  // Revenue formatting
  const revenue = company?.annual_revenue
    ? `$${Math.round(company.annual_revenue / 100_000_000) / 10}M ARR`
    : 'Unknown'

  const lines = [
    `📋 INBOUND LEAD BRIEF — Submitted ${minutesAgo}m ago`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `👤 ${name}${lead.title ? ` — ${lead.title}` : ''}`,
    `🏢 ${company?.name ?? 'Unknown'} | ${company?.employee_count ?? '?'} employees | ${revenue} | ${company?.industry ?? 'Unknown'}`,
    `💻 Tech: ${techLine}`,
    ...(comment ? [`💬 Request: "${comment.slice(0, 200)}"`] : []),
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🎯 Angle: "Since they use ${techStack[0] ?? 'your stack'}, ask how they currently handle lead qualification and routing."`,
  ]

  return lines.join('\n')
}

// ─── start_sequence: Apollo ───────────────────────────────────────────────────

/**
 * Keeps the lead visible (stage stays 'routing', play stays 'running' so the SLA
 * timer keeps watching), enqueues an escalation, and returns the error to throw
 * so the executor writes action_execution_failed with `code`.
 */
async function escalateNoEnrollment(
  leadId: string,
  organizationId: string,
  playInstanceId: string,
  code: string,
  message: string,
  raw: unknown,
): Promise<Error> {
  console.error(`[action-executor] start_sequence escalated: ${code} (org=${organizationId})`)
  await updateLead(leadId, organizationId, { stage: 'routing' })
  try {
    const { addJob } = await import('../queue/setup.js')
    await addJob('escalate-play', { playId: playInstanceId, organizationId, reason: code }, { priority: 2 })
  } catch (escalateErr) {
    console.error(`[action-executor] Failed to enqueue escalation for ${code}: ${escalateErr}`)
  }
  // retryable: false — a missing setting will not fix itself on retry; the escalation already
  // shows it under Needs attention. Retrying would only repeat the whole play.
  return Object.assign(new Error(`${code}: ${message}`), { code, statusCode: 0, raw, retryable: false })
}

async function startApolloSequence(
  action: ProposedAction,
  params: ApolloStartSequenceParams,
  apollo: ConnectorRegistry['apollo'] | null,
  key: string,
  organizationId: string,
  playInstanceId: string,
  decisionSnapshot: DecisionSnapshot,
): Promise<ActionExecutionResult> {
  const leadId = action.target.leadId
  const policyRef = { outreach_policy_id: params.outreach_policy_id, outreach_policy_version: params.outreach_policy_version }

  // Explicit "no sequence" choice (tier set to manual, or active-deal owner follow-up).
  // Not an enrollment: lead stays in 'routing' and the play keeps running so the SLA
  // timer still holds the rep to the response time.
  if (params.plan === 'manual') {
    return {
      success: true,
      output: { enrolled: false, follow_up: 'manual', reason_code: params.reason_code ?? null, tier: params.tier, ...policyRef },
    }
  }

  if (params.plan === 'not_configured') {
    throw await escalateNoEnrollment(leadId, organizationId, playInstanceId,
      params.reason_code ?? 'OUTREACH_NOT_CONFIGURED', params.reason_message ?? 'Outreach is not set up', { ...policyRef, tier: params.tier })
  }

  if (!apollo) {
    throw await escalateNoEnrollment(leadId, organizationId, playInstanceId,
      'NO_SEP_CONNECTOR_AVAILABLE', `Apollo is not connected for org ${organizationId}`, { organizationId })
  }
  const sequenceId = params.apollo_sequence_id
  const emailAccountId = params.apollo_email_account_id
  if (!sequenceId || !emailAccountId) {
    throw await escalateNoEnrollment(leadId, organizationId, playInstanceId,
      'OUTREACH_NOT_CONFIGURED', 'start_sequence is missing the Apollo sequence or mailbox', { ...policyRef })
  }

  const lead = decisionSnapshot.lead
  if (!lead?.email) {
    throw await escalateNoEnrollment(leadId, organizationId, playInstanceId,
      'LEAD_EMAIL_MISSING', 'Lead has no email address to add to a sequence', { leadId })
  }

  let contactId: string
  let campaignStatusId: string | null = null
  let alreadyEnrolled = false
  try {
    // Find first: avoids a duplicate contact and tells us if a retry already enrolled it.
    const contact = await apollo.findContactByEmail(lead.email)
      ?? await apollo.createContact({
        email:            lead.email,
        firstName:        lead.first_name ?? undefined,
        lastName:         lead.last_name ?? undefined,
        title:            lead.title ?? undefined,
        organizationName: decisionSnapshot.company?.name ?? undefined,
        websiteUrl:       decisionSnapshot.company?.domain ? `https://${decisionSnapshot.company.domain}` : undefined,
      }, `${key}:create_contact`)
    contactId = contact.id
    alreadyEnrolled = contact.sequenceIds.includes(sequenceId)
    if (!alreadyEnrolled) {
      const enrollment = await apollo.addContactToSequence(contactId, sequenceId, emailAccountId, `${key}:add_to_sequence`)
      campaignStatusId = enrollment.campaignStatusId
    }
  } catch (err) {
    // A retry cannot fix scope, auth, bad IDs or Apollo refusing the contact: hand to a human.
    const e = err as { statusCode?: number }
    if (err instanceof ConnectorError && NON_RETRYABLE_STATUS.has(e.statusCode ?? -1)) {
      await escalateNoEnrollment(leadId, organizationId, playInstanceId, err.code, err.message, err.raw)
    }
    throw err
  }

  const { error: idErr } = await getDb().from('external_identity').insert({
    organization_id: organizationId,
    entity_type:     'lead',
    entity_id:       leadId,
    provider:        'apollo',
    external_id:     contactId,
    metadata: {
      sequence_id:        sequenceId,
      sequence_name:      params.apollo_sequence_name ?? null,
      email_account_id:   emailAccountId,
      campaign_status_id: campaignStatusId,
      enrolled_by:        'action-executor:start_sequence',
    },
  })
  // Duplicate (org, lead, apollo) = an earlier attempt already stored it. Anything else is logged, not fatal.
  if (idErr && idErr.code !== '23505') console.error(`[action-executor] external_identity apollo insert failed: ${idErr.message}`)

  const now = new Date().toISOString()
  await updatePlayInstance(playInstanceId, organizationId, {
    first_touch_at: now, status: 'completed', sequence_id: sequenceId, enrolled_at: now,
  })
  await updateLead(leadId, organizationId, { stage: 'in_sequence' })
  return {
    success:        true,
    externalSystem: 'apollo' as ConnectorName,
    externalId:     contactId,
    output: {
      enrolled:             true,
      already_enrolled:     alreadyEnrolled,
      apollo_contact_id:    contactId,
      apollo_sequence_id:   sequenceId,
      apollo_sequence_name: params.apollo_sequence_name ?? null,
      campaign_status_id:   campaignStatusId,
      tier:                 params.tier,
      ...policyRef,
    },
  }
}

// ─── Main executor ────────────────────────────────────────────────────────────

export async function executeAction(
  action: ProposedAction,
  connectors: ConnectorRegistry,
  organizationId: string,
  workflowRunId: string,
  playInstanceId: string,
  decisionSnapshot: DecisionSnapshot
): Promise<ActionExecutionResult> {
  const key = action.idempotencyKey

  // ── 1. Idempotency check ───────────────────────────────────────────────────
  const alreadyDone = await existsByIdempotencyKey(organizationId, key)
  if (alreadyDone) {
    await writeEvent({
      organizationId,
      workflowRunId,
      playInstanceId,
      leadId: action.target.leadId,
      eventType: 'action_execution_deduplicated',
      actorType: 'system',
      idempotencyKey: key,
      eventStatus: 'skipped',
      decisionSnapshot,
    })
    return { success: true, output: { deduplicated: true } }
  }

  // ── 2. Emit action_execution_started ──────────────────────────────────────
  await writeEvent({
    organizationId,
    workflowRunId,
    playInstanceId,
    leadId: action.target.leadId,
    eventType: 'action_execution_started',
    actorType: 'system',
    idempotencyKey: key,
    eventStatus: 'success',
    decisionSnapshot,
    proposedAction: action as unknown as Record<string, unknown>,
  })

  let result: ActionExecutionResult = { success: false }

  // ── 3. Execute (try/finally guarantees event is written in step 4/5) ──────
  try {
    switch (action.type) {
      // ── qualify_lead ───────────────────────────────────────────────────────
      case 'qualify_lead': {
        const { is_icp_fit, icp_score, icp_tier } = action.parameters as {
          is_icp_fit: boolean; icp_score: number; icp_tier: string
        }
        await updateLead(action.target.leadId, organizationId, {
          is_icp_fit,
          icp_score,
          icp_tier,
          stage: is_icp_fit ? 'routing' : 'nurture',
        })
        result = { success: true, output: { is_icp_fit, icp_score, icp_tier } }
        break
      }

      // ── assign_owner ───────────────────────────────────────────────────────
      case 'assign_owner': {
        const { recommended_owner_id, queue_name, sf_lead_id } = action.parameters as {
          recommended_owner_id: string; queue_name: string; sf_lead_id?: string
        }

        let externalId: string | undefined
        const sfAvailable = !!connectors?.salesforce

        if (sfAvailable) {
          let resolvedSfLeadId = sf_lead_id

          // If no SF Lead ID exists yet, find-or-create the Lead in Salesforce
          if (!resolvedSfLeadId) {
            const lead = decisionSnapshot.lead

            // Find first — avoids DUPLICATE_VALUE if the lead was already created
            // (e.g. from a previous run attempt or an earlier play for this contact)
            const existing = await connectors.salesforce.findLeadByEmail(lead.email)

            if (existing) {
              resolvedSfLeadId = existing.Id
            } else {
              // Create — lead does not yet exist in Salesforce
              const sfLead = await connectors.salesforce.createLead(
                {
                  firstName:  lead.first_name ?? '',
                  lastName:   lead.last_name ?? 'Unknown',
                  email:      lead.email,
                  title:      lead.title ?? undefined,
                  phone:      lead.phone ?? undefined,
                  company:    decisionSnapshot.company?.name ?? lead.email.split('@')[1] ?? '[Unknown]',
                  leadSource: 'Web',
                },
                `${key}:create_lead`
              )
              resolvedSfLeadId = sfLead.Id
            }

            // Store in external_identity for future plays (best-effort, non-fatal)
            try {
              await getDb().from('external_identity').insert({
                organization_id: organizationId,
                entity_type:     'lead',
                entity_id:       action.target.leadId,
                provider:        'salesforce',
                external_id:     resolvedSfLeadId,
                metadata:        { email: lead.email, created_by: 'action-executor:assign_owner' },
              })
            } catch { /* duplicate key — idempotent, ignore */ }
          }

          if (!resolvedSfLeadId) throw new Error('[action-executor] assign_owner: could not resolve Salesforce Lead ID')
          // Assign owner in Salesforce
          await connectors.salesforce.assignLeadOwner(resolvedSfLeadId, recommended_owner_id, `${key}:assign`)

          // Create call task with briefing card, due at the SLA deadline
          const dueDate = (decisionSnapshot as any).firstTouchDeadline
            ?? new Date(Date.now() + 15 * 60 * 1000).toISOString()
          const briefingCard = buildBriefingCard(
            decisionSnapshot.lead,
            decisionSnapshot.company,
            [],
            decisionSnapshot.lead.raw_payload ?? null
          )
          const task = await connectors.salesforce.createTask(
            resolvedSfLeadId,
            {
              subject: `Call within SLA — ${decisionSnapshot.lead.first_name ?? ''} ${decisionSnapshot.lead.last_name ?? ''} @ ${decisionSnapshot.company?.name ?? ''}`.trim(),
              description: briefingCard,
              due_date: dueDate,
              // Found live: without an owner Salesforce gave the Task to the API "Run As"
              // user, so the assigned rep never saw it in their task list.
              ownerId: recommended_owner_id,
            },
            `${key}:task`
          )
          externalId = task.Id
        } else {
          // SF connector not configured — record intent without crashing.
          // The assigned_owner_id is still written to play_instance so the
          // dashboard can surface it. An operator can manually action in SF.
          console.warn(`[action-executor] assign_owner: SF connector unavailable for org ${organizationId} — recording owner assignment without SF sync`)
        }

        // Always: update play instance and advance routing counter
        await updatePlayInstance(playInstanceId, organizationId, {
          assigned_owner_id:   recommended_owner_id,
          assigned_owner_name: (action.parameters as any).owner_name ?? (action.parameters as any).recommended_owner_name ?? null,
          status: 'running',
        })
        await incrementRoutingStateIndex(organizationId, queue_name)

        result = {
          success: true,
          ...(sfAvailable ? { externalSystem: 'salesforce' as ConnectorName, externalId } : {}),
          output: {
            owner_id:              recommended_owner_id,
            sf_synced:             sfAvailable,
            ...(sfAvailable ? {} : { sf_skip_reason: 'salesforce_not_connected' }),
            ...(externalId ? { task_id: externalId } : {}),
          },
        }
        break
      }

      // ── start_sequence ─────────────────────────────────────────────────────
      case 'start_sequence': {
        // ── v1: Apollo Sequences ────────────────────────────────────────────────
        if ((action.parameters as { provider?: string }).provider === 'apollo') {
          result = await startApolloSequence(
            action, action.parameters as unknown as ApolloStartSequenceParams,
            connectors?.apollo ?? null, key, organizationId, playInstanceId, decisionSnapshot,
          )
          break
        }

        // ── Legacy Outreach / Salesloft (unreachable in v1) ─────────────────────
        const params = action.parameters as {
          outreach_prospect_id?: string
          sequence_id?:          string
          salesloft_person_id?:  string
          cadence_id?:           string
        }

        // ── Outreach enrollment path ──────────────────────────────────────────
        const outreachAvailable = !!connectors?.outreach
          && !!params.outreach_prospect_id
          && !!params.sequence_id
        let sequenceStateId: string | undefined

        if (outreachAvailable) {
          const seqState = await connectors.outreach.enrollInSequence(
            params.outreach_prospect_id!, params.sequence_id!, key
          )
          sequenceStateId = seqState.id
          try {
            await getDb().from('external_identity').insert({
              organization_id: action.target.organizationId ?? organizationId,
              entity_type:     'lead',
              entity_id:       action.target.leadId,
              provider:        'outreach',
              external_id:     params.outreach_prospect_id,
              metadata: {
                sequence_id:       params.sequence_id,
                sequence_state_id: sequenceStateId,
                enrolled_by:       'action-executor:start_sequence',
              },
            })
          } catch { /* duplicate key — idempotent, ignore */ }
        }

        // ── Salesloft enrollment path ─────────────────────────────────────────
        const salesloftAvailable = !outreachAvailable
          && !!connectors?.salesloft
          && !!params.salesloft_person_id
          && !!params.cadence_id
        let cadenceMembershipId: number | undefined

        if (salesloftAvailable) {
          const membership = await connectors.salesloft.enrollInCadence(
            Number(params.salesloft_person_id!), Number(params.cadence_id!), key
          )
          cadenceMembershipId = membership.id
          try {
            await getDb().from('external_identity').insert({
              organization_id: action.target.organizationId ?? organizationId,
              entity_type:     'lead',
              entity_id:       action.target.leadId,
              provider:        'salesloft',
              external_id:     params.salesloft_person_id,
              metadata: {
                cadence_id:            params.cadence_id,
                cadence_membership_id: cadenceMembershipId,
                enrolled_by:           'action-executor:start_sequence',
              },
            })
          } catch { /* duplicate key — idempotent, ignore */ }
        }

        // ── Warn if neither enrolled ──────────────────────────────────────────
        // CRITICAL: do NOT set stage='in_sequence' or status='completed' if no enrollment
        // happened. Doing so causes the lead to silently disappear from the "needs contact"
        // queue while the SLA timer stops watching it. Instead: escalate and keep stage='routing'.
        if (!outreachAvailable && !salesloftAvailable) {
          console.error(
            `[action-executor] start_sequence: no SEP connector available — escalating. ` +
            `outreach_prospect_id=${params.outreach_prospect_id ?? 'missing'}, ` +
            `sequence_id=${params.sequence_id ?? 'missing'}, ` +
            `salesloft_person_id=${params.salesloft_person_id ?? 'missing'}, ` +
            `cadence_id=${params.cadence_id ?? 'missing'} (org=${organizationId})`
          )
          // Keep play visible: stage stays 'routing', play status stays 'running'
          // so the SLA timer continues to watch it and human operators can act.
          await updateLead(action.target.leadId, organizationId, { stage: 'routing' })
          // Enqueue escalation at priority 2 (lower than SLA breach at priority 1)
          try {
            const { addJob } = await import('../queue/setup.js')
            await addJob('escalate-play', { playId: playInstanceId, organizationId }, { priority: 2 })
          } catch (escalateErr) {
            console.error(`[action-executor] Failed to enqueue escalation for no-SEP: ${escalateErr}`)
          }
          // Throw so the try/catch writes action_execution_failed to event_log
          throw Object.assign(
            new Error(`NO_SEP_CONNECTOR_AVAILABLE: no Outreach or Salesloft connector configured for org ${organizationId}`),
            { code: 'NO_SEP_CONNECTOR_AVAILABLE', statusCode: 0, raw: { organizationId } }
          )
        }

        const enrolled = outreachAvailable || salesloftAvailable
        await updatePlayInstance(playInstanceId, organizationId, {
          first_touch_at: new Date().toISOString(),
          status: 'completed',
          ...(outreachAvailable ? { sequence_id: params.sequence_id, enrolled_at: new Date().toISOString() } : {}),
          ...(salesloftAvailable ? { cadence_id: params.cadence_id, enrolled_at: new Date().toISOString() } : {}),
        })
        await updateLead(action.target.leadId, organizationId, { stage: 'in_sequence' })
        result = {
          success: true,
          ...(outreachAvailable && sequenceStateId ? { externalSystem: 'outreach' as ConnectorName, externalId: sequenceStateId } : {}),
          ...(salesloftAvailable && cadenceMembershipId ? { externalSystem: 'salesloft' as ConnectorName, externalId: String(cadenceMembershipId) } : {}),
          output: {
            outreach_synced:  outreachAvailable,
            salesloft_synced: salesloftAvailable,
            enrolled,
            ...(params.outreach_prospect_id ? { outreach_prospect_id: params.outreach_prospect_id } : {}),
            ...(sequenceStateId ? { sequence_state_id: sequenceStateId } : {}),
            ...(params.salesloft_person_id ? { salesloft_person_id: params.salesloft_person_id } : {}),
            ...(cadenceMembershipId ? { cadence_membership_id: cadenceMembershipId } : {}),
          },
        }
        break
      }


      // ── mark_nurture ───────────────────────────────────────────────────────
      case 'mark_nurture': {
        await updateLead(action.target.leadId, organizationId, { stage: 'nurture' })
        await updatePlayInstance(playInstanceId, organizationId, { status: 'nurture' })
        result = { success: true, output: { stage: 'nurture' } }
        break
      }

      // ── mark_duplicate ─────────────────────────────────────────────────────
      case 'mark_duplicate': {
        await updateLead(action.target.leadId, organizationId, { is_duplicate: true })
        await updatePlayInstance(playInstanceId, organizationId, { status: 'completed' })
        result = { success: true, output: { is_duplicate: true } }
        break
      }

      // ── request_human_review ───────────────────────────────────────────────
      case 'request_human_review': {
        // A new review cycle: record what the reviewer needs and clear any earlier decision,
        // so the Approvals page shows it and a stale resume job cannot apply an old decision.
        const p = action.parameters as Record<string, unknown>
        const reviewKind: ReviewKind = p.review_kind === 'sequence' ? 'sequence' : 'routing'
        const reviewContext: ReviewContext = {
          reason_codes:           action.rationale.reasonCodes ?? [],
          queue_name:             (p.queue_name as string | undefined) ?? null,
          recommended_owner_id:   (p.recommended_owner_id as string | undefined) ?? null,
          recommended_owner_name: (p.recommended_owner_name as string | undefined) ?? (p.owner_name as string | undefined) ?? null,
          ...(reviewKind === 'sequence' ? { sequence_name: (p.apollo_sequence_name as string | undefined) ?? null } : {}),
        }
        await updatePlayInstance(playInstanceId, organizationId, {
          status:                 'paused',
          pending_approval_since: new Date().toISOString(),
          review_kind:            reviewKind,
          review_context:         reviewContext,
          review_decision:        null,
          review_decided_at:      null,
          review_decided_by:      null,
        })
        result = { success: true, output: { status: 'pending_human', review_kind: reviewKind } }
        break
      }

      // ── escalate ───────────────────────────────────────────────────────────
      case 'escalate': {
        // Already handled by escalate.worker.ts via BullMQ
        await updatePlayInstance(playInstanceId, organizationId, { status: 'failed' })
        result = { success: true, output: { status: 'escalated' } }
        break
      }

      default: {
        throw new Error(`[action-executor] Unknown action type: ${(action as any).type}`)
      }
    }

    // ── 4. Emit action_execution_succeeded ───────────────────────────────────
    await writeEvent({
      organizationId,
      workflowRunId,
      playInstanceId,
      leadId: action.target.leadId,
      eventType: 'action_execution_succeeded',
      actorType: 'system',
      idempotencyKey: key,
      eventStatus: 'success',
      externalSystem: result.externalSystem,
      externalId: result.externalId,
      decisionSnapshot,
    })

    return result
  } catch (err) {
    // ── 5. Emit action_execution_failed (always, even if step 3 threw) ──────
    const connErr = err as any
    await writeEvent({
      organizationId,
      workflowRunId,
      playInstanceId,
      leadId: action.target.leadId,
      eventType: 'action_execution_failed',
      actorType: 'system',
      idempotencyKey: key,
      eventStatus: 'failed',
      errorCode: connErr?.code ?? 'UNKNOWN_ERROR',
      errorMessage: connErr?.message ?? 'Unknown error',
      errorRaw: connErr?.raw,
      decisionSnapshot,
    })
    throw err
  }
}
