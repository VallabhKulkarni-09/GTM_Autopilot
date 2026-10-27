/**
 * evidence-store.test.ts
 * Unit tests for evidence-store.ts and context-builder.ts.
 * Mocks: Supabase createClient
 * Does NOT mock: business logic in the store/builder
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ClearbitPerson, ClearbitCompany } from '../../connectors/clearbit/clearbit.types.js'

// ─── Mock Supabase ────────────────────────────────────────────────────────────

const mockSingle = vi.fn()

// Default resolved value for awaited chains
let mockResolve: { data: unknown; error: unknown } = { data: [], error: null }

/**
 * Build a thenable chain. Every method returns another thenable chain.
 * Awaiting the chain returns mockResolve. .single() returns mockSingle result.
 */
function buildChain(): any {
  const chain: any = {
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve(mockResolve).then(resolve)
    },
    catch(reject: (e: unknown) => unknown) {
      return Promise.resolve(mockResolve).catch(reject)
    },
    single: mockSingle,
  }
  return new Proxy(chain, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return (..._args: unknown[]) => buildChain()
    },
  })
}

vi.mock('../../db/client.js', () => ({
  getDb: () => ({
    from: (_table: string) => ({
      select: () => buildChain(),
      insert: (rows: unknown[]) => ({
        select: () => Promise.resolve(mockInsertResult(rows)),
      }),
    }),
  }),
  _resetDbClient: vi.fn(),
}))


function mockInsertResult(rows: unknown[]) {
  // Return rows with generated IDs
  return {
    data: (rows as Record<string, unknown>[]).map((r, i) => ({ id: `ev_${i}`, ...r })),
    error: null,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORG = 'org_1'
const LEAD_ID = 'lead_1'

const fullPerson: ClearbitPerson = {
  id: 'cb_person_1',
  email: 'alice@acme.com',
  name: { fullName: 'Alice', givenName: 'Alice', familyName: null },
  location: 'San Francisco, CA',
  timeZone: 'America/Los_Angeles',
  utcOffset: -7,
  geo: { city: 'San Francisco', state: 'CA', country: 'US', lat: 37.77, lng: -122.4 },
  bio: null,
  site: null,
  avatar: null,
  employment: {
    domain: 'acme.com',
    name: 'Acme',
    title: 'VP of Sales',
    role: 'sales',
    seniority: 'vp',
    subRole: null,
  },
  linkedin: { handle: null },
  twitter: { handle: null },
  github: { handle: null },
  company: null,
}

const fullCompany: ClearbitCompany = {
  id: 'cb_company_1',
  name: 'Acme Corp',
  legalName: null,
  domain: 'acme.com',
  domainAliases: [],
  site: { phoneNumbers: [], emailAddresses: [] },
  category: { sector: 'Technology', industryGroup: null, industry: 'Software', subIndustry: null, sicCode: null, naicsCode: null },
  tags: ['b2b', 'saas'],
  metrics: { employees: 250, estimatedAnnualRevenue: 25_000_000 },
  geo: { country: 'US', state: 'CA', city: 'San Francisco' },
  type: 'private',
} as any

// ─── Tests: evidence-store ────────────────────────────────────────────────────

describe('storeEnrichmentEvidence', () => {
  it('null person + null company → throws (caller must guard against null, not pass it through)', async () => {
    // Old behavior: returned [] silently. New behavior: throws so the bug is immediately visible.
    // The null case means "no enrichment match found" — callers must log enrichment_skipped
    // and NOT call storeEnrichmentEvidence with null inputs.
    const { storeEnrichmentEvidence } = await import('../evidence-store.js')
    await expect(
      storeEnrichmentEvidence(ORG, LEAD_ID, null, null, null, 'clearbit')
    ).rejects.toThrow('storeEnrichmentEvidence called with both clearbitPerson=null and clearbitCompany=null')
  })

  it('creates correct number of evidence rows from Clearbit response', async () => {
    const { storeEnrichmentEvidence } = await import('../evidence-store.js')
    // Person gives 4 facts: title, seniority, role, location
    // Company gives 6 facts: employees, industry, revenue, country, type, tags
    const result = await storeEnrichmentEvidence(ORG, LEAD_ID, 'company_1', fullPerson, fullCompany, 'clearbit')
    expect(result.length).toBe(10)
  })

  it('sets expires_at to approximately NOW() + 30 days', async () => {
    const { storeEnrichmentEvidence } = await import('../evidence-store.js')
    const before = Date.now()
    const result = await storeEnrichmentEvidence(ORG, LEAD_ID, null, fullPerson, null, 'clearbit')
    const after = Date.now()

    expect(result.length).toBeGreaterThan(0)
    const expiresAt = new Date(result[0].expires_at!).getTime()
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyDays - 1000)
    expect(expiresAt).toBeLessThanOrEqual(after + thirtyDays + 1000)
  })
})

// ─── Tests: context-builder ───────────────────────────────────────────────────

describe('buildDecisionSnapshot', () => {
  it('throws if lead does not exist', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'Not found' } })
    const { buildDecisionSnapshot } = await import('../context-builder.js')
    await expect(
      buildDecisionSnapshot({ organizationId: ORG, leadId: 'missing', workflowRunId: 'wf_1', agentName: 'test', agentVersion: '1.0.0' })
    ).rejects.toThrow('not found')
  })

  it('includes all required fields when lead exists', async () => {
    // Lead found
    mockSingle.mockResolvedValueOnce({ data: { id: LEAD_ID, organization_id: ORG, company_id: null }, error: null })
    // No company (company_id is null)
    mockResolve = { data: [], error: null }

    const { buildDecisionSnapshot } = await import('../context-builder.js')
    const snapshot = await buildDecisionSnapshot({
      organizationId: ORG,
      leadId: LEAD_ID,
      workflowRunId: 'wf_1',
      agentName: 'qualification-agent',
      agentVersion: '1.0.0',
    })

    expect(snapshot).toMatchObject({
      lead: { id: LEAD_ID },
      company: null,
      policies: expect.any(Array),
      ownerWorkloads: expect.any(Object),
      evidenceIds: expect.any(Array),
      agentName: 'qualification-agent',
      agentVersion: '1.0.0',
      promptVersion: null,
      modelName: null,
    })
  })
})
