/**
 * build.ts — turns a GoldenCase into the exact inputs the agents take.
 * Deterministic: fixed ids and timestamps, no clock, no randomness.
 */

import type { Lead, Company, PolicyRule, RoutingState } from '../domain/db-types.js'
import type { QualificationInput, ProposedAction } from '../agents/qualification/types.js'
import type { RoutingInput, SalesforceUser } from '../agents/routing/types.js'
import { DEFAULT_ICP_CONFIG } from '../agents/qualification/icp-config.js'
import type { GoldenCase, GoldenOwner, GoldenTerritory } from './types.js'

export const GOLDEN_ORG_ID = '00000000-0000-4000-8000-00000000901d'
const T = '2026-10-27T00:00:00.000Z'

export const GOLDEN_OWNERS: GoldenOwner[] = [
  { id: 'rep_a', name: 'Rep A', active: true, available: true },
  { id: 'rep_b', name: 'Rep B', active: true, available: true },
  { id: 'rep_c', name: 'Rep C', active: true, available: true },
  { id: 'rep_d', name: 'Rep D', active: true, available: true },
]

export const GOLDEN_TERRITORIES: GoldenTerritory[] = [
  { queue: 'na', countries: ['US', 'CA'], ownerIds: ['rep_a', 'rep_b'] },
  { queue: 'emea', countries: ['GB', 'DE', 'NL'], ownerIds: ['rep_c'] },
  { queue: 'apac', countries: ['AU'], ownerIds: ['rep_d'] },
]

export const GOLDEN_MAX_OPEN_LEADS = 25

function policy(id: string, rule_type: PolicyRule['rule_type'], priority: number,
  conditions: Record<string, unknown>, actions: Record<string, unknown> | null): PolicyRule {
  return {
    id, organization_id: GOLDEN_ORG_ID, rule_type, name: id, description: null, version: 1,
    is_active: true, priority, conditions, actions, effective_from: T, effective_until: null,
    created_at: T, updated_at: T,
  }
}

export function buildLead(c: GoldenCase): Lead {
  return {
    id: `lead-${c.id}`, organization_id: GOLDEN_ORG_ID, email: c.lead.email,
    first_name: c.lead.first_name ?? null, last_name: c.lead.last_name ?? null,
    title: c.lead.title ?? null, phone: null, company_id: c.company ? `company-${c.id}` : null,
    stage: 'new', form_submitted_at: T, source: c.lead.source, raw_payload: c.lead.raw_payload ?? null,
    is_duplicate: false, is_icp_fit: null, icp_score: null, icp_tier: null,
    is_test: false, removed_at: null, created_at: T, updated_at: T,
  }
}

export function buildCompany(c: GoldenCase): Company | null {
  if (!c.company) return null
  const k = c.company
  return {
    id: `company-${c.id}`, organization_id: GOLDEN_ORG_ID, name: k.name ?? null, domain: k.domain ?? null,
    industry: k.industry ?? null, sub_industry: null, employee_count: k.employee_count ?? null,
    employee_range: null, annual_revenue: null, country: k.country ?? null, state: null, city: null,
    founded_year: null, tech_stack: null, funding_stage: null, raw_clearbit: null, created_at: T, updated_at: T,
  }
}

export function buildIcpPolicy(c: GoldenCase): PolicyRule {
  return policy('golden-icp', 'icp_filter', 1, { ...DEFAULT_ICP_CONFIG, ...c.icpOverrides }, null)
}

export function buildQualificationInput(c: GoldenCase): QualificationInput {
  return { lead: buildLead(c), company: buildCompany(c), enrichmentEvidence: [], icpPolicyRules: [buildIcpPolicy(c)] }
}

/** Throws for cases without a routing setup — routing them would be a dataset bug. */
export function buildRoutingInput(c: GoldenCase, qualificationResult: ProposedAction): RoutingInput {
  if (!c.routing) throw new Error(`GOLDEN_CASE_HAS_NO_ROUTING: ${c.id}`)
  const r = c.routing
  const territories = (r.territories ?? GOLDEN_TERRITORIES).map((t, i) => policy(
    `golden-territory-${t.queue}`, 'territory', i + 1,
    t.countries === 'all' ? { operator: 'all' } : { field: 'country', operator: 'in', values: t.countries },
    { queue_name: t.queue, owner_ids: t.ownerIds },
  ))
  const owners: SalesforceUser[] = (r.owners ?? GOLDEN_OWNERS).map(o => ({
    Id: o.id, Name: o.name, Email: `${o.id}@example.com`, IsActive: o.active, IsAvailable: o.available,
  }))
  const routingState: RoutingState = {
    id: `rs-${c.id}`, organization_id: GOLDEN_ORG_ID, queue_name: 'golden', counter: r.roundRobinCounter,
    last_assigned_owner_id: null, last_assigned_at: null, created_at: T, updated_at: T,
  }
  return {
    lead: buildLead(c), company: buildCompany(c), qualificationResult, availableOwners: owners,
    ownerWorkloads: r.workloads, territoryPolicyRules: territories, routingState,
    maxOpenLeadsPerRep: r.maxOpenLeadsPerRep ?? GOLDEN_MAX_OPEN_LEADS,
  }
}
