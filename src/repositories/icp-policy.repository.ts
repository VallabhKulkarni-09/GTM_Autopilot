/**
 * icp-policy.repository.ts — queries for the org's "Ideal customer" policy row
 * (policy_rules.rule_type = 'icp_filter'). Queries only; validation lives in icp-config.ts.
 */

import { getDb } from '../db/client.js'

export type IcpPolicyRow = {
  id: string
  version: number
  conditions: Record<string, unknown>
  updated_at: string
}

const COLUMNS = 'id, version, conditions, updated_at'

/** The active icp_filter row with the highest priority (lowest number), or null. */
export async function getActiveIcpPolicy(organizationId: string): Promise<IcpPolicyRow | null> {
  const { data, error } = await getDb()
    .from('policy_rules')
    .select(COLUMNS)
    .eq('organization_id', organizationId)
    .eq('rule_type', 'icp_filter')
    .eq('is_active', true)
    .order('priority', { ascending: true })
    .limit(1)
  if (error) throw new Error(`getActiveIcpPolicy failed: ${error.message}`)
  return ((data ?? [])[0] as IcpPolicyRow | undefined) ?? null
}

/**
 * Saves new conditions and bumps the version. Matches on the expected current version so two
 * concurrent saves can't silently overwrite each other; returns null if the row changed meanwhile.
 */
export async function updateIcpPolicy(
  organizationId: string,
  id: string,
  expectedVersion: number,
  conditions: Record<string, unknown>,
): Promise<IcpPolicyRow | null> {
  const { data, error } = await getDb()
    .from('policy_rules')
    .update({ conditions, version: expectedVersion + 1, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('version', expectedVersion)
    .select(COLUMNS)
  if (error) throw new Error(`updateIcpPolicy failed: ${error.message}`)
  return ((data ?? [])[0] as IcpPolicyRow | undefined) ?? null
}
