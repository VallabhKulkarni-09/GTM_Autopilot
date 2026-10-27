/**
 * play-review.repository.ts — human review + attention queries on play_instance.
 * Every query is scoped by organization_id first. No business logic.
 */

import { getDb } from '../db/client.js'
import type { PlayStatus, ReviewContext, ReviewDecision, ReviewKind } from '../domain/db-types.js'

export type ReviewPlayRow = {
  id: string
  lead_id: string
  status: PlayStatus
  workflow_run_id: string | null
  first_touch_deadline: string
  first_touch_at: string | null
  sla_breached: boolean
  sla_breached_at: string | null
  pending_approval_since: string | null
  review_kind: ReviewKind | null
  review_context: ReviewContext | null
  review_decision: ReviewDecision | null
  review_decided_at: string | null
  escalated_at: string | null
  escalation_reason: string | null
  assigned_owner_name: string | null
}

const COLUMNS = 'id, lead_id, status, workflow_run_id, first_touch_deadline, first_touch_at, sla_breached, sla_breached_at, ' +
  'pending_approval_since, review_kind, review_context, review_decision, review_decided_at, escalated_at, escalation_reason, assigned_owner_name'

export type LeadBrief = { id: string; email: string; first_name: string | null; last_name: string | null; title: string | null; company_name: string | null }

export async function getPlayForReview(organizationId: string, playId: string): Promise<ReviewPlayRow | null> {
  const { data, error } = await getDb()
    .from('play_instance')
    .select(COLUMNS)
    .eq('organization_id', organizationId)
    .eq('id', playId)
    .is('removed_at', null)
    .maybeSingle()
  if (error) throw new Error(`getPlayForReview failed: ${error.message}`)
  return (data as unknown as ReviewPlayRow | null) ?? null
}

/**
 * Records the first decision on a paused play. Atomic: only one caller can win
 * (status = paused AND no decision yet). Null when someone already decided.
 */
export async function claimReviewDecision(
  organizationId: string,
  playId: string,
  decision: ReviewDecision,
): Promise<ReviewPlayRow | null> {
  const { data, error } = await getDb()
    .from('play_instance')
    .update({
      review_decision:   decision,
      review_decided_at: decision.decided_at,
      review_decided_by: decision.actor_user_id,
      updated_at:        new Date().toISOString(),
    })
    .eq('organization_id', organizationId)
    .eq('id', playId)
    .eq('status', 'paused')
    .is('review_decided_at', null)
    .select(COLUMNS)
  if (error) throw new Error(`claimReviewDecision failed: ${error.message}`)
  return ((data ?? [])[0] as unknown as ReviewPlayRow | undefined) ?? null
}

/** paused → running for the decision being applied. False if the play moved on already. */
export async function markPlayResumed(organizationId: string, playId: string, decidedAt: string): Promise<boolean> {
  const { data, error } = await getDb()
    .from('play_instance')
    .update({ status: 'running', pending_approval_since: null, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('id', playId)
    .eq('status', 'paused')
    .eq('review_decided_at', decidedAt)
    .select('id')
  if (error) throw new Error(`markPlayResumed failed: ${error.message}`)
  return (data ?? []).length > 0
}

export async function markPlayEscalated(organizationId: string, playId: string, reason: string): Promise<void> {
  const { error } = await getDb()
    .from('play_instance')
    .update({ escalated_at: new Date().toISOString(), escalation_reason: reason, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('id', playId)
  if (error) throw new Error(`markPlayEscalated failed: ${error.message}`)
}

/** Paused plays, oldest first (decided ones included: they are being resumed). */
export async function listAwaitingReview(organizationId: string, limit: number): Promise<{ rows: ReviewPlayRow[]; total: number }> {
  const { data, error, count } = await getDb()
    .from('play_instance')
    .select(COLUMNS, { count: 'exact' })
    .eq('organization_id', organizationId)
    .eq('status', 'paused')
    .is('removed_at', null)
    .order('pending_approval_since', { ascending: true, nullsFirst: false })
    .limit(limit)
  if (error) throw new Error(`listAwaitingReview failed: ${error.message}`)
  return { rows: (data ?? []) as unknown as ReviewPlayRow[], total: count ?? 0 }
}

/** Breached the response time and still not contacted. */
export async function listSlaBreachedUncontacted(organizationId: string, limit: number): Promise<{ rows: ReviewPlayRow[]; total: number }> {
  const { data, error, count } = await getDb()
    .from('play_instance')
    .select(COLUMNS, { count: 'exact' })
    .eq('organization_id', organizationId)
    .eq('sla_breached', true)
    .is('first_touch_at', null)
    .in('status', ['running', 'paused'])
    .is('removed_at', null)
    .order('sla_breached_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`listSlaBreachedUncontacted failed: ${error.message}`)
  return { rows: (data ?? []) as unknown as ReviewPlayRow[], total: count ?? 0 }
}

/** Escalated for another reason (e.g. outreach not set up), not breached yet, not contacted. */
export async function listEscalatedUncontacted(organizationId: string, limit: number): Promise<{ rows: ReviewPlayRow[]; total: number }> {
  const { data, error, count } = await getDb()
    .from('play_instance')
    .select(COLUMNS, { count: 'exact' })
    .eq('organization_id', organizationId)
    .not('escalated_at', 'is', null)
    .eq('sla_breached', false)
    .is('first_touch_at', null)
    .eq('status', 'running')
    .is('removed_at', null)
    .order('escalated_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`listEscalatedUncontacted failed: ${error.message}`)
  return { rows: (data ?? []) as unknown as ReviewPlayRow[], total: count ?? 0 }
}

export async function getLeadBriefs(organizationId: string, leadIds: string[]): Promise<Map<string, LeadBrief>> {
  const out = new Map<string, LeadBrief>()
  if (leadIds.length === 0) return out
  const { data: leads, error } = await getDb()
    .from('leads')
    .select('id, email, first_name, last_name, title, company_id')
    .eq('organization_id', organizationId)
    .in('id', leadIds)
  if (error) throw new Error(`getLeadBriefs failed: ${error.message}`)
  const companyIds = [...new Set((leads ?? []).map(l => l.company_id).filter(Boolean))] as string[]
  const names = new Map<string, string>()
  if (companyIds.length) {
    const { data: companies, error: cErr } = await getDb()
      .from('companies')
      .select('id, name')
      .eq('organization_id', organizationId)
      .in('id', companyIds)
    if (cErr) throw new Error(`getLeadBriefs companies failed: ${cErr.message}`)
    for (const c of companies ?? []) names.set(c.id, c.name)
  }
  for (const l of leads ?? []) {
    out.set(l.id, {
      id: l.id, email: l.email, first_name: l.first_name, last_name: l.last_name, title: l.title,
      company_name: l.company_id ? names.get(l.company_id) ?? null : null,
    })
  }
  return out
}
