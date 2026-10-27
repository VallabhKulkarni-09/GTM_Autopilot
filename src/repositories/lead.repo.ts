/**
 * lead.repo.ts
 * Repository functions for the leads table.
 * All queries are organization-scoped (no exceptions).
 */

import { getDb } from '../db/client.js'
import type { Lead, UpdateLead } from '../domain/db-types.js'

export const leadRepo = {
  async getById(organizationId: string, leadId: string): Promise<Lead | null> {
    const { data, error } = await getDb()
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .eq('organization_id', organizationId)
      .single()
    if (error || !data) return null
    return data as Lead
  },

  async getByEmail(organizationId: string, email: string): Promise<Lead | null> {
    const { data, error } = await getDb()
      .from('leads')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('email', email)
      .limit(1)
      .single()
    if (error || !data) return null
    return data as Lead
  },

  /**
   * Returns true if another non-duplicate lead with the same email already exists
   * in this org. Pass excludeLeadId to prevent a freshly-inserted lead from
   * matching itself.
   */
  async isDuplicate(organizationId: string, email: string, excludeLeadId?: string): Promise<boolean> {
    let query = getDb()
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('email', email)
      .eq('is_duplicate', false)
      .eq('is_test', false)   // test leads never make a lead a duplicate, and vice versa (migration 031)
    if (excludeLeadId) {
      query = (query as any).neq('id', excludeLeadId)
    }
    const { count, error } = await (query as any)
    if (error) return false
    return (count ?? 0) > 0
  },

  async update(organizationId: string, leadId: string, data: UpdateLead): Promise<void> {
    const { error } = await getDb()
      .from('leads')
      .update(data)
      .eq('id', leadId)
      .eq('organization_id', organizationId)
    if (error) throw new Error(`[lead-repo] update failed: ${error.message}`)
  },

  async list(organizationId: string, opts: {
    page?: number
    limit?: number
    stage?: string
  } = {}): Promise<{ data: Lead[]; total: number }> {
    const { page = 1, limit = 50, stage } = opts
    const from = (page - 1) * limit

    let query = getDb()
      .from('leads')
      .select('*', { count: 'exact' })
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1)

    if (stage) query = (query as any).eq('stage', stage)

    const { data, count, error } = await (query as any)
    if (error) throw new Error(`[lead-repo] list failed: ${error.message}`)
    return { data: (data ?? []) as Lead[], total: count ?? 0 }
  },

  /**
   * Returns the most recent play_instance for any lead with this email in this org,
   * excluding the lead identified by excludeLeadId (the current incoming lead).
   *
   * Used by validate.ts to determine re-enrollment eligibility:
   *   - If no prior play exists → lead is new → let through.
   *   - If a prior play exists → check its status and how long ago it ended.
   */
  async getLatestPlayForEmail(
    organizationId: string,
    email: string,
    excludeLeadId?: string
  ): Promise<{ status: string; updated_at: string; first_touch_at: string | null } | null> {
    // Find all leads with this email (excluding the current one)
    let leadQuery = getDb()
      .from('leads')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('email', email)
      .eq('is_test', false)   // a test lead is never a "returning lead"
    if (excludeLeadId) {
      leadQuery = (leadQuery as any).neq('id', excludeLeadId)
    }
    const { data: leads, error: leadErr } = await (leadQuery as any)
    if (leadErr || !leads || leads.length === 0) return null

    const leadIds = leads.map((l: any) => l.id as string)

    // Find the most recent play_instance for those leads
    const { data: plays, error: playErr } = await getDb()
      .from('play_instance')
      .select('status, updated_at, first_touch_at')
      .eq('organization_id', organizationId)
      .in('lead_id', leadIds)
      .order('updated_at', { ascending: false })
      .limit(1)

    if (playErr || !plays || plays.length === 0) return null
    return plays[0] as { status: string; updated_at: string; first_touch_at: string | null }
  },
}
