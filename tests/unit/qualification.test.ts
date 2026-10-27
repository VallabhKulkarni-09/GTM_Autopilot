/**
 * qualification.test.ts — 10 evaluation cases for QualificationAgent v1.
 * Pure unit tests — no DB, no network, zero external dependencies.
 */

import { describe, it, expect } from 'vitest'
import { qualificationAgent } from '../../src/agents/qualification/index'
import type { QualificationInput } from '../../src/agents/qualification/types'
import type { Lead, Company, PolicyRule } from '../../src/domain/db-types'
import { DEFAULT_ICP_CONFIG } from '../../src/agents/qualification/icp-config'

const icpPolicy = (conditions: Record<string, unknown> = { ...DEFAULT_ICP_CONFIG }): PolicyRule => ({
  id: 'icp-1', organization_id: 'org-1', rule_type: 'icp_filter', name: 'Ideal customer',
  description: null, version: 3, is_active: true, priority: 30, conditions, actions: null,
  effective_from: '', effective_until: null, created_at: '', updated_at: '',
})

const makeLeadBase = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'lead-1', organization_id: 'org-1', email: 'test@example.com',
  first_name: 'John', last_name: 'Smith', title: null, phone: null,
  stage: 'new', source: 'hubspot:form', company_id: null, raw_payload: null,
  form_submitted_at: new Date().toISOString(),
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  ...overrides,
})

const makeCompany = (overrides: Partial<Company> = {}): Company => ({
  id: 'co-1', organization_id: 'org-1', name: 'Acme Corp',
  domain: 'acme.com', industry: 'SaaS', employee_count: 250,
  country: 'US', raw_payload: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  ...overrides,
})

const makeInput = (lead: Lead, company: Company | null): QualificationInput => ({
  lead, company, enrichmentEvidence: [], icpPolicyRules: [icpPolicy()],
})

// ── Case 1: Perfect match — all fields, tier_1 ────────────────────────────────
describe('QualificationAgent — Case 1: Perfect match', () => {
  it('returns tier_1 with score >= 70', () => {
    const lead = makeLeadBase({ title: 'VP of Sales', source: 'demo' })
    const company = makeCompany({ employee_count: 500, industry: 'SaaS', country: 'US' })
    const result = qualificationAgent.run(makeInput(lead, company))
    expect(result.type).toBe('qualify_lead')
    expect(result.parameters.icp_tier).toBe('tier_1')
    expect(result.parameters.is_icp_fit).toBe(true)
    expect(result.parameters.icp_score).toBeGreaterThanOrEqual(70)
    expect(result.decisionRiskScore).toBe(0.0)
    expect(result.rawConfidence).toBe(1.0)
  })
})

// ── Case 2: Partial match — missing company size → tier_2 ─────────────────────
describe('QualificationAgent — Case 2: Partial match (missing size)', () => {
  it('returns tier_2 when company size is missing', () => {
    const lead = makeLeadBase({ source: 'trial' })
    const company = makeCompany({ employee_count: null as any, industry: 'Software', country: 'GB' })
    const result = qualificationAgent.run(makeInput(lead, company))
    expect(result.parameters.icp_tier).not.toBe('tier_1')
    expect(['tier_2', 'not_icp']).toContain(result.parameters.icp_tier)
    expect(result.parameters.reason_codes).toContain('ENRICHMENT_MISSING_COMPANY_SIZE')
  })
})

// ── Case 3: Not ICP — company too small (hard gate for < 10 employees) ────────
describe('QualificationAgent — Case 3: Not ICP (too small + wrong params)', () => {
  it('returns not_icp with DISQUALIFIED_TOO_SMALL reason for micro-companies', () => {
    const lead = makeLeadBase()
    const company = makeCompany({ employee_count: 5, industry: 'Agriculture', country: 'CN' })
    const result = qualificationAgent.run(makeInput(lead, company))
    expect(result.parameters.icp_tier).toBe('not_icp')
    expect(result.parameters.is_icp_fit).toBe(false)
    expect(result.parameters.reason_codes).toContain('DISQUALIFIED_TOO_SMALL')
  })
})

// ── Case 4: Not ICP — wrong industry ──────────────────────────────────────────
describe('QualificationAgent — Case 4: Not ICP (industry mismatch)', () => {
  it('returns not_icp for non-ICP industry', () => {
    const lead = makeLeadBase()
    const company = makeCompany({ employee_count: 300, industry: 'Agriculture', country: 'US' })
    const result = qualificationAgent.run(makeInput(lead, company))
    expect(result.parameters.reason_codes).toContain('NOT_ICP_INDUSTRY_MISMATCH')
    expect(result.parameters.icp_score).toBeLessThan(70)
  })
})

// ── Case 5: Not ICP — excluded region ─────────────────────────────────────────
describe('QualificationAgent — Case 5: Not ICP (excluded region)', () => {
  it('returns lower score for excluded country', () => {
    const lead = makeLeadBase()
    const company = makeCompany({ employee_count: 300, industry: 'SaaS', country: 'CN' })
    const result = qualificationAgent.run(makeInput(lead, company))
    expect(result.parameters.reason_codes).toContain('NOT_ICP_REGION_EXCLUDED')
  })
})

// ── Case 6: Company is null — does not crash ───────────────────────────────────
describe('QualificationAgent — Case 6: Null company', () => {
  it('handles null company without crashing', () => {
    const lead = makeLeadBase({ title: 'Director of Engineering', source: 'demo' })
    expect(() => qualificationAgent.run(makeInput(lead, null))).not.toThrow()
    const result = qualificationAgent.run(makeInput(lead, null))
    expect(result.type).toBe('qualify_lead')
    expect(result.parameters.reason_codes.length).toBeGreaterThan(0)
  })
})

// ── Case 7: Missing industry only ─────────────────────────────────────────────
describe('QualificationAgent — Case 7: Missing industry', () => {
  it('handles missing industry — partial score', () => {
    const lead = makeLeadBase({ source: 'trial', title: 'CTO' })
    const company = makeCompany({ industry: null as any, employee_count: 300, country: 'US' })
    const result = qualificationAgent.run(makeInput(lead, company))
    expect(result.parameters.reason_codes).toContain('ENRICHMENT_MISSING_INDUSTRY')
    expect(result.parameters.icp_score).toBeGreaterThan(0)
  })
})

// ── Case 8: Enterprise company (5000+ employees) — partial credit ─────────────
describe('QualificationAgent — Case 8: Enterprise company', () => {
  it('gives partial credit (ICP_COMPANY_SIZE_LARGE) for 5000+ employees', () => {
    const lead = makeLeadBase()
    const company = makeCompany({ employee_count: 5000, industry: 'Technology', country: 'US' })
    const result = qualificationAgent.run(makeInput(lead, company))
    expect(result.parameters.reason_codes).toContain('ICP_COMPANY_SIZE_LARGE')
    expect(result.parameters.icp_score).toBeGreaterThan(0)
  })
})

// ── Case 9: High intent + senior title + right region — wrong industry ─────────
describe('QualificationAgent — Case 9: High intent, wrong industry', () => {
  it('scores high intent and title despite industry mismatch', () => {
    const lead = makeLeadBase({ title: 'VP Engineering', source: 'demo-request' })
    const company = makeCompany({ employee_count: 200, industry: 'Retail', country: 'CA' })
    const result = qualificationAgent.run(makeInput(lead, company))
    expect(result.parameters.reason_codes).toContain('ICP_HIGH_INTENT_FORM')
    expect(result.parameters.reason_codes).toContain('ICP_SENIOR_TITLE')
    expect(result.parameters.reason_codes).toContain('NOT_ICP_INDUSTRY_MISMATCH')
  })
})

// ── Case 10: Duplicate email lead — still qualifies (dedup handled elsewhere) ─
describe('QualificationAgent — Case 10: Lead from duplicate email', () => {
  it('still runs qualification without checking for duplicates (not its job)', () => {
    const lead = makeLeadBase({ email: 'duplicate@example.com', source: 'trial', title: 'CEO' })
    const company = makeCompany({ employee_count: 200, industry: 'SaaS', country: 'DE' })
    const result = qualificationAgent.run(makeInput(lead, company))
    // Agent must not refuse to score; dedup is handled by separate dedup step
    expect(result.type).toBe('qualify_lead')
    expect(result.parameters.icp_score).toBeGreaterThan(0)
  })
})

// ── Config-driven behaviour ───────────────────────────────────────────────────
describe('QualificationAgent — ICP policy', () => {
  const lead = makeLeadBase({ email: 'a@acme.com', title: 'VP of Sales', source: 'demo' })
  const company = makeCompany({ employee_count: 500, industry: 'SaaS', country: 'US' })

  it('throws ICP_POLICY_MISSING when the org has no active ICP policy', () => {
    expect(() => qualificationAgent.run({ lead, company, enrichmentEvidence: [], icpPolicyRules: [] }))
      .toThrow(/ICP_POLICY_MISSING/)
    const inactive = { ...icpPolicy(), is_active: false }
    expect(() => qualificationAgent.run({ lead, company, enrichmentEvidence: [], icpPolicyRules: [inactive] }))
      .toThrow(/ICP_POLICY_MISSING/)
  })

  it('throws on an invalid stored config instead of defaulting', () => {
    const { weights: _w, ...broken } = DEFAULT_ICP_CONFIG
    expect(() => qualificationAgent.run({ lead, company, enrichmentEvidence: [], icpPolicyRules: [icpPolicy(broken)] }))
      .toThrow(/weights/)
  })

  it('records the policy id and version that scored the lead', () => {
    const r = qualificationAgent.run(makeInput(lead, company))
    expect(r.parameters.icp_policy_id).toBe('icp-1')
    expect(r.parameters.icp_policy_version).toBe(3)
  })

  it('uses configured industries, countries and thresholds', () => {
    const cfg = { ...DEFAULT_ICP_CONFIG, industries: ['fintech'], countries: ['IN'], tier_thresholds: { tier_1: 90, tier_2: 20 } }
    const fintech = makeCompany({ employee_count: 500, industry: 'Fintech', country: 'IN' })
    const r = qualificationAgent.run({ lead, company: fintech, enrichmentEvidence: [], icpPolicyRules: [icpPolicy(cfg)] })
    expect(r.parameters.reason_codes).toContain('ICP_INDUSTRY_SAAS')
    expect(r.parameters.icp_score).toBe(100)
    const saas = qualificationAgent.run({ lead, company, enrichmentEvidence: [], icpPolicyRules: [icpPolicy(cfg)] })
    expect(saas.parameters.reason_codes).toContain('NOT_ICP_INDUSTRY_MISMATCH')
    expect(saas.parameters.icp_tier).toBe('tier_2') // 30 + 15 + 10 = 55 < 90
  })

  it('lets free-email leads through when the gate is off', () => {
    const gmail = makeLeadBase({ email: 'a@gmail.com', source: 'demo' })
    const off = qualificationAgent.run({ lead: gmail, company, enrichmentEvidence: [], icpPolicyRules: [icpPolicy({ ...DEFAULT_ICP_CONFIG, block_free_email: false })] })
    expect(off.parameters.reason_codes).not.toContain('DISQUALIFIED_FREE_EMAIL_PROVIDER')
    const on = qualificationAgent.run(makeInput(gmail, company))
    expect(on.parameters.reason_codes).toContain('DISQUALIFIED_FREE_EMAIL_PROVIDER')
  })
})
