/**
 * policy-engine.test.ts — Unit tests for evaluatePolicy.
 * All tests run without credentials (mocked supabase).
 */

import { describe, it, expect, vi } from 'vitest'
import type { Lead, Company, PolicyRule } from '../../src/domain/db-types'

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'l1', organization_id: 'org-1', email: 'test@example.com',
  first_name: null, last_name: null, title: null, phone: null,
  stage: 'new', source: 'hubspot', company_id: null, raw_payload: null,
  form_submitted_at: new Date().toISOString(),
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  ...overrides,
})

const makeCompany = (overrides: Partial<Company> = {}): Company => ({
  id: 'co-1', organization_id: 'org-1', name: 'Test Co', domain: 'test.com',
  industry: 'SaaS', employee_count: 200, country: 'US', raw_payload: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  ...overrides,
})

const makeRule = (condition: any): PolicyRule => ({
  id: 'rule-1', organization_id: 'org-1', name: 'Test Rule',
  rule_type: 'icp_filter', is_active: true, priority: 1,
  condition, parameters: {},
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
} as any)

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: vi.fn().mockResolvedValue({ data: null, error: null }) }) }),
    }),
  }),
}))

process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_SERVICE_KEY = 'test-key'

import { evaluatePolicy } from '../../src/policies/policy-engine'

describe('policy-engine — evaluatePolicy', () => {
  it('"in" operator matches correctly', async () => {
    const rule = makeRule({ field: 'country', operator: 'in', values: ['US', 'CA', 'GB'] })
    const result = await evaluatePolicy(rule, makeLead(), makeCompany({ country: 'US' }))
    expect(result.passed).toBe(true)
  })

  it('"in" operator rejects correctly', async () => {
    const rule = makeRule({ field: 'country', operator: 'in', values: ['US', 'CA', 'GB'] })
    const result = await evaluatePolicy(rule, makeLead(), makeCompany({ country: 'JP' }))
    expect(result.passed).toBe(false)
    expect(result.reasonCode).toContain('REJECTED')
  })

  it('"gte" operator — passes when value >= threshold', async () => {
    const rule = makeRule({ field: 'employee_count', operator: 'gte', value: 100 })
    expect((await evaluatePolicy(rule, makeLead(), makeCompany({ employee_count: 200 }))).passed).toBe(true)
  })

  it('"gte" operator — fails when value < threshold', async () => {
    const rule = makeRule({ field: 'employee_count', operator: 'gte', value: 500 })
    expect((await evaluatePolicy(rule, makeLead(), makeCompany({ employee_count: 50 }))).passed).toBe(false)
  })

  it('"and" compound condition — both must pass', async () => {
    const rule = makeRule({
      operator: 'and',
      conditions: [
        { field: 'country', operator: 'in', values: ['US'] },
        { field: 'industry', operator: 'eq', value: 'saas' },
      ],
    })
    expect((await evaluatePolicy(rule, makeLead(), makeCompany({ country: 'US', industry: 'SaaS' }))).passed).toBe(true)
    expect((await evaluatePolicy(rule, makeLead(), makeCompany({ country: 'JP', industry: 'SaaS' }))).passed).toBe(false)
  })

  it('null company field — does not crash', async () => {
    const rule = makeRule({ field: 'employee_count', operator: 'gte', value: 100 })
    await expect(evaluatePolicy(rule, makeLead(), null)).resolves.not.toThrow()
  })

  it('"contains" operator — matches substring', async () => {
    const rule = makeRule({ field: 'source', operator: 'contains', value: 'demo' })
    expect((await evaluatePolicy(rule, makeLead({ source: 'demo-request' }), null)).passed).toBe(true)
  })

  it('returns correct ruleName and ruleId', async () => {
    const rule = makeRule({ field: 'country', operator: 'in', values: ['US'] })
    const result = await evaluatePolicy(rule, makeLead(), makeCompany())
    expect(result.ruleName).toBe('Test Rule')
    expect(result.ruleId).toBe('rule-1')
  })
})
