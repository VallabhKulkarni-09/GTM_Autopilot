/**
 * validate.ts — deduplication + re-enrollment node.
 *
 * Three-step check:
 * 1. Is there any existing lead with this email in this org? If no → dedup_passed.
 * 2. If yes → load the most recent play for that email.
 * 3. Is the prior play in a terminal state (completed | nurture | failed) AND
 *    did it end more than allow_after_days ago? If yes → reenrollment_allowed.
 *    Otherwise → dedup_rejected.
 *
 * Re-enrollment window:
 *   Default: 90 days (ASSUMPTION: no customer data; treat as a placeholder — see migration 023).
 *   Configurable: policy_rules WHERE rule_type='re_enrollment' AND organization_id=<org>.
 *   The actions JSONB must contain { "allow_after_days": <number> }.
 */

import { WorkflowState } from '../state.js'
import { leadRepo } from '../../../repositories/lead.repo.js'
import { writeEvent } from '../../../events/event-log.js'
import { buildDecisionSnapshot } from '../../../evidence/context-builder.js'
import { getDb } from '../../../db/client.js'

// Terminal play statuses — a play in one of these states is eligible for re-enrollment
// after the configured time window.
const TERMINAL_STATUSES = new Set(['completed', 'nurture', 'failed'])

// ASSUMPTION: 90-day default has no empirical basis — calibrate with customer data.
// See db/migrations/023_reenrollment_policy.sql for details.
const DEFAULT_REENROLL_DAYS = 90

async function getReenrollmentWindowDays(organizationId: string): Promise<number> {
  try {
    const { data, error } = await getDb()
      .from('policy_rules')
      .select('actions')
      .eq('organization_id', organizationId)
      .eq('rule_type', 're_enrollment')
      .eq('is_active', true)
      .order('priority', { ascending: false })
      .limit(1)
      .single()

    if (error || !data) return DEFAULT_REENROLL_DAYS
    const days = (data.actions as any)?.allow_after_days
    if (typeof days === 'number' && days > 0) return days
    return DEFAULT_REENROLL_DAYS
  } catch {
    return DEFAULT_REENROLL_DAYS
  }
}

export async function validate(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const decisionSnapshot = await buildDecisionSnapshot(state as any)

  // ── Step 1: Does any other lead with this email exist? ─────────────────────
  const isDup = await leadRepo.isDuplicate(state.organizationId, state.lead.email, state.leadId)

  if (!isDup) {
    // No prior lead — new lead, proceed normally
    await writeEvent({
      organizationId: state.organizationId,
      workflowRunId:  state.workflowRunId,
      playInstanceId: state.playInstanceId,
      leadId:         state.leadId,
      eventType:      'dedup_passed',
      actorType:      'system',
      decisionSnapshot,
      eventStatus:    'success',
    })
    return { currentStep: 'validate', lead: state.lead }
  }

  // ── Step 2: Load the most recent prior play for this email ─────────────────
  const priorPlay = await leadRepo.getLatestPlayForEmail(
    state.organizationId,
    state.lead.email,
    state.leadId
  )

  // ── Step 3: Re-enrollment eligibility check ────────────────────────────────
  if (priorPlay) {
    const isTerminal   = TERMINAL_STATUSES.has(priorPlay.status)
    const allowDays    = await getReenrollmentWindowDays(state.organizationId)
    const allowMs      = allowDays * 24 * 60 * 60 * 1000
    // Use first_touch_at if available (means a play actually ran); else updated_at
    const referenceDate = new Date(priorPlay.first_touch_at ?? priorPlay.updated_at)
    const ageMs         = Date.now() - referenceDate.getTime()
    const isOldEnough   = ageMs >= allowMs

    if (isTerminal && isOldEnough) {
      // Re-enrollment allowed: prior play is done and old enough
      await writeEvent({
        organizationId: state.organizationId,
        workflowRunId:  state.workflowRunId,
        playInstanceId: state.playInstanceId,
        leadId:         state.leadId,
        eventType:      'reenrollment_allowed',
        actorType:      'system',
        decisionSnapshot: {
          ...decisionSnapshot,
          reenrollmentContext: {
            priorPlayStatus: priorPlay.status,
            priorPlayAge:    Math.round(ageMs / (1000 * 60 * 60 * 24)) + 'd',
            allowAfterDays:  allowDays,
          },
        },
        eventStatus: 'success',
      })
      // Mark lead as NOT duplicate so it can proceed through the pipeline
      return {
        currentStep: 'validate',
        lead: { ...state.lead, is_duplicate: false } as any,
      }
    }
  }

  // ── Default: reject as duplicate ───────────────────────────────────────────
  // (either no prior play found, or play is non-terminal, or within the time window)
  const updatedLead = { ...state.lead, is_duplicate: true } as any
  await writeEvent({
    organizationId: state.organizationId,
    workflowRunId:  state.workflowRunId,
    playInstanceId: state.playInstanceId,
    leadId:         state.leadId,
    eventType:      'dedup_rejected',
    actorType:      'system',
    decisionSnapshot,
    eventStatus:    'success',
  })
  return { currentStep: 'validate', lead: updatedLead }
}
