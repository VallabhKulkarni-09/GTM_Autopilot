/**
 * context-builder.ts
 * Assembles the full DecisionSnapshot required by every event_log write.
 *
 * IMPORTANT:
 * - Called for every event. Must be fast. All queries use primary keys / indexes.
 * - Throws if lead not found — never fails silently.
 * - ownerWorkloads = COUNT(*) of running play_instances per assigned_owner_id
 */

import { getDb } from '../db/client.js'
import type { Lead, Company, PolicyRule, DecisionSnapshot } from '../domain/db-types.js'

export type BuildDecisionSnapshotParams = {
  organizationId: string
  leadId: string
  workflowRunId: string
  agentName: string
  agentVersion: string
  promptVersion?: string | null
  modelName?: string | null
}

export async function buildDecisionSnapshot(
  params: BuildDecisionSnapshotParams
): Promise<DecisionSnapshot> {
  const { organizationId, leadId, agentName, agentVersion, promptVersion = null, modelName = null } = params
  const client = getDb()

  // ── Lead (throws if not found) ────────────────────────────────────────────
  const { data: lead, error: leadError } = await client
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .single()

  if (leadError || !lead) {
    throw new Error(
      `[context-builder] buildDecisionSnapshot: Lead ${leadId} not found in org ${organizationId}. ` +
      `Error: ${leadError?.message ?? 'no data returned'}`
    )
  }

  // ── Company (optional, null if no company linked) ─────────────────────────
  let company: Company | null = null
  if ((lead as Lead).company_id) {
    const { data: companyData } = await client
      .from('companies')
      .select('*')
      .eq('id', (lead as Lead).company_id)
      .eq('organization_id', organizationId)
      .single()
    company = (companyData as Company) ?? null
  }

  // ── Active policies for org ───────────────────────────────────────────────
  const { data: policiesData } = await client
    .from('policy_rules')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('is_active', true)

  const policies: PolicyRule[] = (policiesData ?? []) as PolicyRule[]

  // ── Owner workloads: active play count per SF user ────────────────────────
  // Use neq instead of not().is() for broader compatibility
  const { data: workloadData } = await client
    .from('play_instance')
    .select('assigned_owner_id')
    .eq('organization_id', organizationId)
    .eq('status', 'running')
    .is('removed_at', null)   // a removed test lead no longer counts toward a rep's limit
    .neq('assigned_owner_id', null)

  const ownerWorkloads: Record<string, number> = {}
  for (const row of workloadData ?? []) {
    const ownerId = (row as any).assigned_owner_id as string
    ownerWorkloads[ownerId] = (ownerWorkloads[ownerId] ?? 0) + 1
  }

  // ── Current non-expired evidence IDs for this lead ────────────────────────
  const { data: evidenceData } = await client
    .from('evidence')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('lead_id', leadId)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)

  const evidenceIds: string[] = (evidenceData ?? []).map((e: any) => e.id as string)

  return {
    lead: lead as Lead,
    company,
    policies,
    ownerWorkloads,
    evidenceIds,
    agentName,
    agentVersion,
    promptVersion: promptVersion ?? null,
    modelName: modelName ?? null,
  }
}
