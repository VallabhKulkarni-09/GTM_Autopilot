/**
 * reps.repository.ts — sales reps (Salesforce users) stored in external_identity
 * (provider = 'salesforce', entity_type = 'user'), and the routing/territory policy rows.
 * Queries only. Every query is scoped by organization_id.
 */

import { randomUUID } from 'crypto'
import { getDb } from '../db/client.js'

export type RepMetadata = {
  name: string
  email: string
  title: string | null
  available: boolean     // taking new leads
  sf_active: boolean     // still an active user in Salesforce (as of last import)
  imported_at: string
}

export type RepRow = { id: string; external_id: string; metadata: RepMetadata }

const REP_FILTER = { provider: 'salesforce', entity_type: 'user' } as const

export async function listReps(organizationId: string): Promise<RepRow[]> {
  const { data, error } = await getDb()
    .from('external_identity')
    .select('id, external_id, metadata')
    .eq('organization_id', organizationId)
    .eq('provider', REP_FILTER.provider)
    .eq('entity_type', REP_FILTER.entity_type)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`listReps failed: ${error.message}`)
  return (data ?? []) as RepRow[]
}

export async function insertRep(organizationId: string, externalId: string, metadata: RepMetadata): Promise<void> {
  const { error } = await getDb().from('external_identity').insert({
    organization_id: organizationId,
    ...REP_FILTER,
    entity_id: randomUUID(),   // our internal ID for the rep
    external_id: externalId,
    metadata,
  })
  if (error) throw new Error(`insertRep failed: ${error.message}`)
}

export async function updateRepMetadata(organizationId: string, id: string, metadata: RepMetadata): Promise<RepRow | null> {
  const { data, error } = await getDb()
    .from('external_identity')
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('id', id)
    .eq('provider', REP_FILTER.provider)
    .eq('entity_type', REP_FILTER.entity_type)
    .select('id, external_id, metadata')
  if (error) throw new Error(`updateRepMetadata failed: ${error.message}`)
  return ((data ?? [])[0] as RepRow | undefined) ?? null
}

// ── Policy rows (routing + territory) ────────────────────────────────────────

export type PolicyRowLite = {
  id: string
  name: string
  version: number
  priority: number
  conditions: Record<string, unknown>
  actions: Record<string, unknown> | null
}

const POLICY_COLUMNS = 'id, name, version, priority, conditions, actions'

export async function listActivePolicies(organizationId: string, ruleType: 'routing' | 'territory' | 'outreach'): Promise<PolicyRowLite[]> {
  const { data, error } = await getDb()
    .from('policy_rules')
    .select(POLICY_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('rule_type', ruleType)
    .eq('is_active', true)
    .order('priority', { ascending: true })
  if (error) throw new Error(`listActivePolicies failed: ${error.message}`)
  return (data ?? []) as PolicyRowLite[]
}

export async function insertPolicy(
  organizationId: string,
  ruleType: 'territory',
  row: { name: string; description: string; conditions: Record<string, unknown>; actions: Record<string, unknown>; priority: number },
): Promise<PolicyRowLite> {
  const { data, error } = await getDb()
    .from('policy_rules')
    .insert({ organization_id: organizationId, rule_type: ruleType, is_active: true, ...row })
    .select(POLICY_COLUMNS)
    .single()
  if (error || !data) throw new Error(`insertPolicy failed: ${error?.message ?? 'no row'}`)
  return data as PolicyRowLite
}

/** Updates an active policy row of the given type, bumping its version. Null if not found in this org. */
export async function updatePolicy(
  organizationId: string,
  ruleType: 'routing' | 'territory' | 'outreach',
  id: string,
  currentVersion: number,
  changes: Partial<{ name: string; conditions: Record<string, unknown>; actions: Record<string, unknown>; priority: number; is_active: boolean }>,
): Promise<PolicyRowLite | null> {
  const { data, error } = await getDb()
    .from('policy_rules')
    .update({ ...changes, version: currentVersion + 1, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('rule_type', ruleType)
    .eq('id', id)
    .eq('version', currentVersion)
    .select(POLICY_COLUMNS)
  if (error) throw new Error(`updatePolicy failed: ${error.message}`)
  return ((data ?? [])[0] as PolicyRowLite | undefined) ?? null
}
