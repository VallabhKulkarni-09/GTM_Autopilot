/**
 * org-members.repository.ts — workspace membership lookups.
 * Membership is the ONLY source of a request's organization_id.
 */

import { getDb } from '../db/client.js'
import type { MemberRole } from '../middleware/types.js'

export type MembershipRow = {
  organization_id: string
  role: MemberRole
  created_at: string
}

/** All workspaces a user belongs to, oldest first. */
export async function getMembershipsForUser(userId: string): Promise<MembershipRow[]> {
  const { data, error } = await getDb()
    .from('org_members')
    .select('organization_id, role, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`getMembershipsForUser failed: ${error.message}`)
  return (data ?? []) as MembershipRow[]
}

export async function addMember(organizationId: string, userId: string, email: string, role: MemberRole): Promise<void> {
  const { error } = await getDb()
    .from('org_members')
    .upsert({ organization_id: organizationId, user_id: userId, email, role }, { onConflict: 'organization_id,user_id' })
  if (error) throw new Error(`addMember failed: ${error.message}`)
}
