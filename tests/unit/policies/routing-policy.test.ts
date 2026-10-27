import { describe, it, expect } from 'vitest'
import { selectRoutingPolicy, territoryRow, readTerritory } from '../../../src/policies/routing-policy'
import { DEFAULT_POLICIES } from '../../../src/policies/default-policies'
import type { PolicyRule } from '../../../src/domain/db-types'

const rule = (actions: Record<string, unknown> | null, over: Partial<PolicyRule> = {}): PolicyRule => ({
  id: 'r1', organization_id: 'o', rule_type: 'routing', name: 'Lead assignment', description: null, version: 1,
  is_active: true, priority: 40, conditions: {}, actions, effective_from: '', effective_until: null, created_at: '', updated_at: '', ...over,
})

describe('routing policy', () => {
  it('reads max_open_leads_per_rep', () => {
    expect(selectRoutingPolicy([rule({ max_open_leads_per_rep: 12 })]).maxOpenLeadsPerRep).toBe(12)
  })
  it('throws when missing or inactive', () => {
    expect(() => selectRoutingPolicy([])).toThrow(/ROUTING_POLICY_MISSING/)
    expect(() => selectRoutingPolicy([rule({ max_open_leads_per_rep: 5 }, { is_active: false })])).toThrow(/ROUTING_POLICY_MISSING/)
  })
  it('throws on invalid values instead of defaulting', () => {
    for (const v of [undefined, 0, -1, 2.5, '25']) {
      expect(() => selectRoutingPolicy([rule({ max_open_leads_per_rep: v })])).toThrow(/ROUTING_POLICY_INVALID/)
    }
  })
  it('new workspaces get 25 and a catch-all territory', () => {
    const routing = DEFAULT_POLICIES.find(p => p.rule_type === 'routing')!
    expect(routing.actions).toEqual({ max_open_leads_per_rep: 25 })
    const t = DEFAULT_POLICIES.find(p => p.rule_type === 'territory')!
    expect(readTerritory({ conditions: t.conditions, actions: t.actions })).toEqual({ countries: null, ownerIds: null })
  })
  it('territoryRow writes the territory shape and round-trips', () => {
    const row = territoryRow({ name: 'North America', countries: ['us', 'CA', 'US'], ownerIds: ['005A'], priority: 10 })
    expect(row.conditions).toEqual({ field: 'country', operator: 'in', values: ['US', 'CA'] })
    expect(row.actions).toEqual({ queue_name: 'north-america', owner_ids: ['005A'] })
    expect(readTerritory(row)).toEqual({ countries: ['US', 'CA'], ownerIds: ['005A'] })
  })
})
