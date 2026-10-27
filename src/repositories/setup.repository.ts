/**
 * setup.repository.ts — organizations.setup_completed_at (migration 025). Queries only.
 */

import { getDb } from '../db/client.js'

export async function getSetupCompletedAt(organizationId: string): Promise<string | null> {
  const { data, error } = await getDb()
    .from('organizations')
    .select('setup_completed_at')
    .eq('id', organizationId)
    .single()
  if (error) throw new Error(`getSetupCompletedAt failed: ${error.message}`)
  return (data?.setup_completed_at as string | null) ?? null
}

/** Stamps setup_completed_at once. Returns the stored value (the earlier one if already set). */
export async function markSetupCompleted(organizationId: string, completedAt: string): Promise<string> {
  const db = getDb()
  const { data, error } = await db
    .from('organizations')
    .update({ setup_completed_at: completedAt, updated_at: completedAt })
    .eq('id', organizationId)
    .is('setup_completed_at', null)
    .select('setup_completed_at')
  if (error) throw new Error(`markSetupCompleted failed: ${error.message}`)
  if ((data ?? []).length > 0) return completedAt
  const existing = await getSetupCompletedAt(organizationId)
  if (!existing) throw new Error(`markSetupCompleted failed: workspace ${organizationId} not found`)
  return existing
}
