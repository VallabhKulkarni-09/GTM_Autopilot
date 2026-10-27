/**
 * routing.test.ts — 10 evaluation cases for RoutingAgent v1.
 * Pure unit tests — zero external dependencies.
 */

import { describe, it, expect } from 'vitest'
import { routingAgent } from '../../src/agents/routing/index'
import type { RoutingInput, SalesforceUser } from '../../src/agents/routing/types'
import type { Lead, Company, PolicyRule, RoutingState } from '../../src/domain/db-types'

const makeLead = (): Lead => ({
  id: 'lead-1', organization_id: 'org-1', email: 'test@example.com',
  first_name: 'Test', last_name: 'User', title: 'VP', phone: null,
  stage: 'new', source: 'hubspot', company_id: null, raw_payload: null,
  form_submitted_at: new Date().toISOString(),
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
})

const makeCompany = (overrides: Partial<Company> = {}): Company => ({
  id: 'co-1', organization_id: 'org-1', name: 'Acme', domain: 'acme.com',
  industry: 'SaaS', employee_count: 200, country: 'US', raw_payload: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  ...overrides,
})

const makeTerritoryRule = (country: string | string[], queueName: string, ownerIds?: string[]): PolicyRule => ({
  id: `rule-${queueName}`, organization_id: 'org-1', name: `Territory ${queueName}`,
  rule_type: 'territory', is_active: true, priority: 1,
  conditions: { field: 'country', operator: 'in', values: Array.isArray(country) ? country : [country] },
  actions: { queue_name: queueName, owner_ids: ownerIds ?? null },
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
} as any)

const makeOwner = (id: string, name: string): SalesforceUser => ({ Id: id, Name: name, Email: `${id}@co.com`, IsActive: true, IsAvailable: true })

const makeRoutingState = (index: number = 0): RoutingState => ({
  id: 'rs-1', organization_id: 'org-1', queue_name: 'na-smb',
  current_index: index, updated_at: new Date().toISOString(),
} as any)

const qualResult = { type: 'qualify_lead', parameters: { is_icp_fit: true, icp_score: 75, icp_tier: 'tier_1', reason_codes: [] }, decisionRiskScore: 0, rawConfidence: 1 }

// ── Case 1: Clear territory match, single owner ───────────────────────────────
it('Case 1: clear territory match, single owner → assign_owner', () => {
  const input: RoutingInput = {
    lead: makeLead(), company: makeCompany({ country: 'US' }),
    qualificationResult: qualResult,
    availableOwners: [makeOwner('u1', 'Alice')],
    ownerWorkloads: { u1: 3 },
    territoryPolicyRules: [makeTerritoryRule('US', 'na-smb')],
    maxOpenLeadsPerRep: 25,
    routingState: makeRoutingState(0),
  }
  const result = routingAgent.run(input)
  expect(result.type).toBe('assign_owner')
  expect((result.parameters as any).recommended_owner_id).toBe('u1')
  expect((result.parameters as any).queue_name).toBe('na-smb')
})

// ── Case 2: Round-robin — multiple owners, same workload ──────────────────────
it('Case 2: round-robin tie-break with routing_state', () => {
  const input: RoutingInput = {
    lead: makeLead(), company: makeCompany({ country: 'US' }),
    qualificationResult: qualResult,
    availableOwners: [makeOwner('u1', 'Alice'), makeOwner('u2', 'Bob'), makeOwner('u3', 'Carol')],
    ownerWorkloads: { u1: 5, u2: 5, u3: 5 },
    territoryPolicyRules: [makeTerritoryRule('US', 'na-smb')],
    maxOpenLeadsPerRep: 25,
    routingState: makeRoutingState(1),  // index 1 → picks u2
  }
  const result = routingAgent.run(input)
  expect(result.type).toBe('assign_owner')
  expect((result.parameters as any).recommended_owner_id).toBe('u2')
  expect((result.parameters as any).reason_codes).toContain('ROUND_ROBIN_SELECTED')
})

// ── Case 3: Workload-based — assign to least loaded ───────────────────────────
it('Case 3: assigns to least-loaded owner', () => {
  const input: RoutingInput = {
    lead: makeLead(), company: makeCompany({ country: 'US' }),
    qualificationResult: qualResult,
    availableOwners: [makeOwner('u1', 'Alice'), makeOwner('u2', 'Bob')],
    ownerWorkloads: { u1: 20, u2: 3 },
    territoryPolicyRules: [makeTerritoryRule('US', 'na-smb')],
    maxOpenLeadsPerRep: 25,
    routingState: makeRoutingState(0),
  }
  const result = routingAgent.run(input)
  expect(result.type).toBe('assign_owner')
  expect((result.parameters as any).recommended_owner_id).toBe('u2')
  expect((result.parameters as any).reason_codes).toContain('LOWEST_WORKLOAD_SELECTED')
})

// ── Case 4: No territory match → request_human_review ────────────────────────
it('Case 4: no territory match → request_human_review', () => {
  const input: RoutingInput = {
    lead: makeLead(), company: makeCompany({ country: 'JP' }),
    qualificationResult: qualResult,
    availableOwners: [makeOwner('u1', 'Alice')],
    ownerWorkloads: { u1: 0 },
    territoryPolicyRules: [makeTerritoryRule('US', 'na-smb')],
    maxOpenLeadsPerRep: 25,
    routingState: makeRoutingState(0),
  }
  const result = routingAgent.run(input)
  expect(result.type).toBe('request_human_review')
})

// ── Case 5: All owners at capacity → request_human_review ────────────────────
it('Case 5: all owners at max capacity → request_human_review', () => {
  const input: RoutingInput = {
    lead: makeLead(), company: makeCompany({ country: 'US' }),
    qualificationResult: qualResult,
    availableOwners: [makeOwner('u1', 'Alice'), makeOwner('u2', 'Bob')],
    ownerWorkloads: { u1: 25, u2: 30 },
    territoryPolicyRules: [makeTerritoryRule('US', 'na-smb')],
    maxOpenLeadsPerRep: 25,
    routingState: makeRoutingState(0),
  }
  const result = routingAgent.run(input)
  expect(result.type).toBe('request_human_review')
})

// ── Case 6: Single owner in queue ────────────────────────────────────────────
it('Case 6: single owner in queue gets assigned', () => {
  const input: RoutingInput = {
    lead: makeLead(), company: makeCompany({ country: 'DE' }),
    qualificationResult: qualResult,
    availableOwners: [makeOwner('u1', 'Hans'), makeOwner('u2', 'Maria')],
    ownerWorkloads: { u1: 5, u2: 0 },
    territoryPolicyRules: [makeTerritoryRule('DE', 'emea', ['u1'])],
    maxOpenLeadsPerRep: 25,
    routingState: makeRoutingState(0),
  }
  const result = routingAgent.run(input)
  expect(result.type).toBe('assign_owner')
  expect((result.parameters as any).recommended_owner_id).toBe('u1')
})

// ── Case 7: Territory country ambiguous — uses company country ────────────────
it('Case 7: uses company country, not lead country', () => {
  const input: RoutingInput = {
    lead: makeLead(), company: makeCompany({ country: 'GB' }),
    qualificationResult: qualResult,
    availableOwners: [makeOwner('u1', 'Oliver')],
    ownerWorkloads: {},
    territoryPolicyRules: [makeTerritoryRule('GB', 'emea')],
    maxOpenLeadsPerRep: 25,
    routingState: makeRoutingState(0),
  }
  const result = routingAgent.run(input)
  expect(result.type).toBe('assign_owner')
  expect((result.parameters as any).queue_name).toBe('emea')
})

// ── Case 8: New queue, routing_state.current_index = 0 ───────────────────────
it('Case 8: fresh queue (index=0) picks first owner', () => {
  const input: RoutingInput = {
    lead: makeLead(), company: makeCompany({ country: 'AU' }),
    qualificationResult: qualResult,
    availableOwners: [makeOwner('u1', 'Sam'), makeOwner('u2', 'Riley')],
    ownerWorkloads: { u1: 5, u2: 5 },
    territoryPolicyRules: [makeTerritoryRule('AU', 'apac')],
    maxOpenLeadsPerRep: 25,
    routingState: makeRoutingState(0),
  }
  const result = routingAgent.run(input)
  expect(result.type).toBe('assign_owner')
  expect((result.parameters as any).recommended_owner_id).toBe('u1')
})

// ── Case 9: Empty owner list → request_human_review ──────────────────────────
it('Case 9: empty owner list → request_human_review', () => {
  const input: RoutingInput = {
    lead: makeLead(), company: makeCompany({ country: 'US' }),
    qualificationResult: qualResult,
    availableOwners: [],
    ownerWorkloads: {},
    territoryPolicyRules: [makeTerritoryRule('US', 'na-smb')],
    maxOpenLeadsPerRep: 25,
    routingState: makeRoutingState(0),
  }
  const result = routingAgent.run(input)
  expect(result.type).toBe('request_human_review')
  expect((result.parameters as any).reason_codes).toContain('OWNER_LIST_EMPTY')
})

// ── Case 10: Lead from unlisted region ────────────────────────────────────────
it('Case 10: lead from unlisted region → request_human_review', () => {
  const input: RoutingInput = {
    lead: makeLead(), company: makeCompany({ country: 'BR' }),
    qualificationResult: qualResult,
    availableOwners: [makeOwner('u1', 'Ana')],
    ownerWorkloads: {},
    territoryPolicyRules: [makeTerritoryRule('US', 'na-smb'), makeTerritoryRule('DE', 'emea')],
    maxOpenLeadsPerRep: 25,
    routingState: makeRoutingState(0),
  }
  const result = routingAgent.run(input)
  expect(result.type).toBe('request_human_review')
})

// ── Availability, capacity and territory shape ───────────────────────────────
describe('RoutingAgent — reps & territories', () => {
  const base = (over: Partial<RoutingInput> = {}): RoutingInput => ({
    lead: makeLead(), company: makeCompany({ country: 'US' }), qualificationResult: qualResult,
    availableOwners: [makeOwner('u1', 'Alice'), makeOwner('u2', 'Bob')],
    ownerWorkloads: {}, territoryPolicyRules: [makeTerritoryRule('US', 'na')],
    maxOpenLeadsPerRep: 25, routingState: makeRoutingState(0), ...over,
  })
  const codes = (r: ReturnType<typeof routingAgent.run>) => (r.parameters as any).reason_codes as string[]

  it('Case 9: rep on PTO is skipped', () => {
    const r = routingAgent.run(base({ availableOwners: [{ ...makeOwner('u1', 'Alice'), IsAvailable: false }, makeOwner('u2', 'Bob')] }))
    expect((r.parameters as any).recommended_owner_id).toBe('u2')
  })

  it('all reps unavailable → human review with ALL_REPS_UNAVAILABLE', () => {
    const r = routingAgent.run(base({ availableOwners: [{ ...makeOwner('u1', 'A'), IsAvailable: false }] }))
    expect(r.type).toBe('request_human_review')
    expect(codes(r)).toEqual(['ALL_REPS_UNAVAILABLE'])
  })

  it('reps no longer active in Salesforce are never assigned', () => {
    const r = routingAgent.run(base({ availableOwners: [{ ...makeOwner('u1', 'A'), IsActive: false }] }))
    expect(codes(r)).toEqual(['NO_REPS_IN_TERRITORY'])
  })

  it('uses the configured max open leads, not a constant', () => {
    expect(routingAgent.run(base({ ownerWorkloads: { u1: 3, u2: 3 }, maxOpenLeadsPerRep: 3 })).type).toBe('request_human_review')
    expect(codes(routingAgent.run(base({ ownerWorkloads: { u1: 3, u2: 3 }, maxOpenLeadsPerRep: 3 })))).toEqual(['ALL_REPS_AT_CAPACITY'])
    expect(routingAgent.run(base({ ownerWorkloads: { u1: 30, u2: 30 }, maxOpenLeadsPerRep: 31 })).type).toBe('assign_owner')
  })

  it('no territory match → NO_TERRITORY_MATCH', () => {
    expect(codes(routingAgent.run(base({ company: makeCompany({ country: 'BR' }) })))).toEqual(['NO_TERRITORY_MATCH'])
  })

  it('catch-all territory reads queue and reps from actions, by priority', () => {
    const everywhere = { ...makeTerritoryRule('XX', 'everywhere'), priority: 1000, conditions: { operator: 'all' } } as PolicyRule
    const emea = { ...makeTerritoryRule('BR', 'latam', ['u2']), priority: 5 } as PolicyRule
    const r = routingAgent.run(base({ company: makeCompany({ country: 'BR' }), territoryPolicyRules: [everywhere, emea] }))
    expect((r.parameters as any).queue_name).toBe('latam')
    expect((r.parameters as any).recommended_owner_id).toBe('u2')
    const r2 = routingAgent.run(base({ company: makeCompany({ country: 'JP' }), territoryPolicyRules: [everywhere, emea] }))
    expect((r2.parameters as any).queue_name).toBe('everywhere')
  })

  it('territory without queue_name throws instead of defaulting', () => {
    const bad = { ...makeTerritoryRule('US', 'na'), actions: null } as PolicyRule
    expect(() => routingAgent.run(base({ territoryPolicyRules: [bad] }))).toThrow(/TERRITORY_RULE_INVALID/)
  })
})
