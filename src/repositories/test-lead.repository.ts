/**
 * test-lead.repository.ts — test leads sent from the setup page (leads.is_test, migration 031).
 * Queries only. Every query is scoped by organization_id first.
 *
 * Rows are never deleted (event_log references leads and is append-only): "removing" a test
 * lead stamps removed_at on the lead and its plays, which hides them everywhere.
 */

import { getDb } from '../db/client.js'
import type { LeadStage, PlayStatus } from '../domain/db-types.js'

export type TestLeadRow = {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  stage: LeadStage
  icp_tier: 'tier_1' | 'tier_2' | 'not_icp' | null
  form_submitted_at: string
}

export type TestPlayRow = {
  lead_id: string
  status: PlayStatus
  assigned_owner_name: string | null
  created_at: string
}

/** This workspace's test leads that have not been removed, newest first. */
export async function listTestLeads(organizationId: string, limit: number): Promise<TestLeadRow[]> {
  const { data, error } = await getDb()
    .from('leads')
    .select('id, email, first_name, last_name, stage, icp_tier, form_submitted_at')
    .eq('organization_id', organizationId)
    .eq('is_test', true)
    .is('removed_at', null)
    .order('form_submitted_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listTestLeads failed: ${error.message}`)
  return (data ?? []) as TestLeadRow[]
}

/** Plays for the given test leads, newest first (callers keep the first per lead). */
export async function listTestPlays(organizationId: string, leadIds: string[]): Promise<TestPlayRow[]> {
  if (leadIds.length === 0) return []
  const { data, error } = await getDb()
    .from('play_instance')
    .select('lead_id, status, assigned_owner_name, created_at')
    .eq('organization_id', organizationId)
    .in('lead_id', leadIds)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`listTestPlays failed: ${error.message}`)
  return (data ?? []) as TestPlayRow[]
}

/** How many test leads this workspace has ever sent (removed ones included). */
export async function countTestLeads(organizationId: string): Promise<number> {
  const { count, error } = await getDb()
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('is_test', true)
  if (error) throw new Error(`countTestLeads failed: ${error.message}`)
  return count ?? 0
}

/** Hides every not-yet-removed test lead and its plays. Returns how many leads were removed. */
export async function removeTestLeads(organizationId: string, removedAt: string): Promise<number> {
  const db = getDb()
  const { data: leads, error } = await db
    .from('leads')
    .update({ removed_at: removedAt, updated_at: removedAt })
    .eq('organization_id', organizationId)
    .eq('is_test', true)
    .is('removed_at', null)
    .select('id')
  if (error) throw new Error(`removeTestLeads failed: ${error.message}`)

  const { error: playErr } = await db
    .from('play_instance')
    .update({ removed_at: removedAt, updated_at: removedAt })
    .eq('organization_id', organizationId)
    .eq('is_test', true)
    .is('removed_at', null)
  if (playErr) throw new Error(`removeTestLeads (plays) failed: ${playErr.message}`)

  return (leads ?? []).length
}
