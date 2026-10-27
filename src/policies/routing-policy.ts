/**
 * routing-policy.ts — the org's "Lead assignment" settings (policy_rules.rule_type = 'routing',
 * stored in `actions`) and the territory row shape (rule_type = 'territory').
 * Nothing here fills in missing values: invalid or missing config throws.
 */

import type { PolicyRule } from '../domain/db-types.js'

export const MAX_OPEN_LEADS_LIMIT = 10_000

export function parseMaxOpenLeads(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_OPEN_LEADS_LIMIT) {
    throw new Error(`ROUTING_POLICY_INVALID: max_open_leads_per_rep must be a whole number between 1 and ${MAX_OPEN_LEADS_LIMIT}`)
  }
  return raw
}

/** Picks the active routing policy. Throws if the workspace has none. */
export function selectRoutingPolicy(rules: PolicyRule[]): { rule: PolicyRule; maxOpenLeadsPerRep: number } {
  const rule = rules
    .filter(r => r.rule_type === 'routing' && r.is_active)
    .sort((a, b) => a.priority - b.priority)[0]
  if (!rule) {
    throw new Error('ROUTING_POLICY_MISSING: no active lead assignment policy for this workspace. Set it on the Reps & territories page.')
  }
  return { rule, maxOpenLeadsPerRep: parseMaxOpenLeads(rule.actions?.max_open_leads_per_rep) }
}

// ── Territory rows ──────────────────────────────────────────────────────────
// conditions: { field: 'country', operator: 'in', values: ['US', ...] }  or  { operator: 'all' }
// actions:    { queue_name: string, owner_ids: string[] | null }          (Salesforce user IDs; null = every rep)

export type TerritoryInput = {
  name: string
  countries: string[] | null   // null = everywhere (catch-all)
  ownerIds: string[] | null    // Salesforce user IDs; null = every rep
  priority: number
}

export function territoryQueueName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!slug) throw new Error('TERRITORY_NAME_INVALID: name must contain letters or numbers')
  return slug
}

export function territoryRow(t: TerritoryInput): { name: string; conditions: Record<string, unknown>; actions: Record<string, unknown>; priority: number } {
  return {
    name: t.name,
    conditions: t.countries === null
      ? { operator: 'all' }
      : { field: 'country', operator: 'in', values: [...new Set(t.countries.map(c => c.trim().toUpperCase()))] },
    actions: { queue_name: territoryQueueName(t.name), owner_ids: t.ownerIds },
    priority: t.priority,
  }
}

/** Reads a stored territory row back into the editor shape. */
export function readTerritory(rule: Pick<PolicyRule, 'conditions' | 'actions'>): { countries: string[] | null; ownerIds: string[] | null } {
  const c = rule.conditions as { operator?: string; values?: unknown }
  const countries = c.operator === 'all' || c.operator === 'wildcard'
    ? null
    : Array.isArray(c.values) ? (c.values as string[]) : []
  const ids = rule.actions?.owner_ids
  return { countries, ownerIds: Array.isArray(ids) ? (ids as string[]) : null }
}
