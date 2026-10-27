/**
 * apollo-org.connector.test.ts
 *
 * Tests the organization enrichment connector (GET /api/v1/organizations/enrich).
 * All field names and response shapes validated against the real stripe.com response
 * captured on 2026-10-05.
 *
 * Three-way outcome tested with mocked fetch:
 *   1. Network/API error → ConnectorError
 *   2. HTTP 200 + {} (no org key) → null (no match)
 *   3. HTTP 200 + { organization: {...} } → ApolloOrganizationMatch
 *
 * deriveDomainFromEmail and FREE_EMAIL_PROVIDERS gate also tested.
 * Live tests skipped when APOLLO_API_KEY is not set.
 */

import { describe, it, expect } from 'vitest'
import { ApolloConnector, deriveDomainFromEmail } from '../apollo.connector.js'
import { FREE_EMAIL_PROVIDERS } from '../../../agents/qualification/rules.js'
import type { ApolloRawOrganization } from '../apollo.types.js'

const LIVE = !!process.env.APOLLO_API_KEY

// ── Real stripe.com response fields for mocking ───────────────────────────────
// These values are verbatim from the actual API response captured 2026-10-05.

const MOCK_STRIPE_ORG: ApolloRawOrganization = {
  id:                        '5d0a0fbff6512580bf33a120',
  name:                      'Stripe',
  website_url:               'http://www.stripe.com',
  linkedin_url:              'http://www.linkedin.com/company/stripe',
  twitter_url:               'http://twitter.com/stripe',
  facebook_url:              null,
  primary_domain:            'stripe.com',
  industry:                  'information technology & services',
  industries:                ['information technology & services', 'financial services', 'computer software', 'internet'],
  keywords:                  ['payments', 'developer tools'],
  estimated_num_employees:   9400,
  organization_revenue:      6935000000.0,
  organization_revenue_printed: '6.9B',
  annual_revenue:            6935000000.0,
  annual_revenue_printed:    '6.9B',
  total_funding:             9443867423,
  total_funding_printed:     '9.4B',
  latest_funding_stage:      'Venture (Round not Specified)',
  latest_funding_round_date: '2026-03-01T00:00:00.000+00:00',
  founded_year:              2010,
  city:                      'South San Francisco',
  state:                     'California',
  country:                   'United States',
  raw_address:               '354 Oyster Point Blvd, South San Francisco, California 94080, US',
  short_description:         'Stripe, Inc. is a global financial technology company...',
  alexa_ranking:             200,
  phone:                     '+1 415-298-5539',
  sic_codes:                 ['7375'],
  naics_codes:               ['54151'],
  suborganizations:          [{ id: '63444fd1a6719600a40fec3a', name: 'Bridge', website_url: 'http://www.bridge.xyz' }],
  num_suborganizations:      23,
  owned_by_organization_id:  null,
  departmental_head_count:   { engineering: 4301, sales: 1172 },
  org_chart_sector:          'OrgChart::SectorHierarchy::Rules::IT',
  current_technologies:      [{ uid: 'net', name: '.NET', category: 'Frameworks and Programming Languages' }],
  technology_names:          ['.NET', '1Password', 'AI'],
}

// ── deriveDomainFromEmail ─────────────────────────────────────────────────────

describe('deriveDomainFromEmail', () => {
  it('returns the domain for a standard professional email', () => {
    expect(deriveDomainFromEmail('alice@stripe.com')).toBe('stripe.com')
  })

  it('lowercases the domain', () => {
    expect(deriveDomainFromEmail('BOB@STRIPE.COM')).toBe('stripe.com')
  })

  it('returns null for email with no @', () => {
    expect(deriveDomainFromEmail('notanemail')).toBeNull()
  })

  it('returns null for domain with no dot', () => {
    expect(deriveDomainFromEmail('alice@localhost')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(deriveDomainFromEmail('')).toBeNull()
  })
})

// ── FREE_EMAIL_PROVIDERS (from rules.ts, used by enrich.ts gate) ─────────────

describe('FREE_EMAIL_PROVIDERS (shared set from rules.ts)', () => {
  it('contains gmail.com', () => {
    expect(FREE_EMAIL_PROVIDERS.has('gmail.com')).toBe(true)
  })

  it('does not contain stripe.com (a real company domain)', () => {
    expect(FREE_EMAIL_PROVIDERS.has('stripe.com')).toBe(false)
  })

  it('combined: free email domain is detected before Apollo call', () => {
    const domain = deriveDomainFromEmail('test@gmail.com')
    expect(domain).toBe('gmail.com')
    expect(FREE_EMAIL_PROVIDERS.has(domain!)).toBe(true)
  })
})

// ── Organization enrichment — unit tests (always run) ────────────────────────

describe('ApolloConnector.enrichOrganizationByDomain — mocked (always run)', () => {
  it('throws ConnectorError(AP_AUTH_FAILED) on 401', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: 'Invalid API key.', error_details: { code: 'AUTH.AUTHENTICATION.API_KEY_INVALID' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    )
    try {
      const connector = new ApolloConnector()
      await connector.connect({ apiKey: 'bad-key' })
      await expect(
        connector.enrichOrganizationByDomain('stripe.com')
      ).rejects.toMatchObject({ name: 'ConnectorError', code: 'AP_AUTH_FAILED' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws ConnectorError(AP_INSUFFICIENT_SCOPE) on 403', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('Forbidden', { status: 403 })
    try {
      const connector = new ApolloConnector()
      await connector.connect({ apiKey: 'key' })
      await expect(
        connector.enrichOrganizationByDomain('stripe.com')
      ).rejects.toMatchObject({ name: 'ConnectorError', code: 'AP_INSUFFICIENT_SCOPE' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws ConnectorError(AP_RATE_LIMITED) on 429', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('Too Many Requests', { status: 429 })
    try {
      const connector = new ApolloConnector()
      await connector.connect({ apiKey: 'key' })
      await expect(
        connector.enrichOrganizationByDomain('stripe.com')
      ).rejects.toMatchObject({ name: 'ConnectorError', code: 'AP_RATE_LIMITED' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws ConnectorError(AP_NETWORK_ERROR) on network failure', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    try {
      const connector = new ApolloConnector()
      await connector.connect({ apiKey: 'key' })
      await expect(
        connector.enrichOrganizationByDomain('stripe.com')
      ).rejects.toMatchObject({ name: 'ConnectorError', code: 'AP_NETWORK_ERROR' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns null when response is {} (no organization key) — no-match path', async () => {
    // VERIFIED: Real Apollo API returns {} for unknown domains (2026-10-05)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    try {
      const connector = new ApolloConnector()
      await connector.connect({ apiKey: 'key' })
      const result = await connector.enrichOrganizationByDomain('zzz-no-such.invalid')
      expect(result).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('maps real stripe.com response fields correctly to ApolloOrganizationMatch', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      JSON.stringify({ organization: MOCK_STRIPE_ORG }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
    try {
      const connector = new ApolloConnector()
      await connector.connect({ apiKey: 'key' })
      const result = await connector.enrichOrganizationByDomain('stripe.com')

      expect(result).not.toBeNull()
      expect(result!.apolloOrgId).toBe('5d0a0fbff6512580bf33a120')
      expect(result!.name).toBe('Stripe')
      expect(result!.domain).toBe('stripe.com')       // from primary_domain
      expect(result!.industry).toBe('information technology & services')
      expect(result!.industries).toContain('financial services')
      expect(result!.employeeCount).toBe(9400)         // estimated_num_employees
      expect(result!.revenue).toBe(6935000000.0)       // organization_revenue (VERIFIED field name)
      expect(result!.revenuePrinted).toBe('6.9B')
      expect(result!.totalFunding).toBe(9443867423)
      expect(result!.fundingStage).toBe('Venture (Round not Specified)')
      expect(result!.foundedYear).toBe(2010)
      expect(result!.location.city).toBe('South San Francisco')    // top-level (NOT nested)
      expect(result!.location.state).toBe('California')
      expect(result!.location.country).toBe('United States')
      expect(result!.techStack).toContain('.NET')
      // _raw preserved for audit
      expect(result!._raw.id).toBe('5d0a0fbff6512580bf33a120')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('enrichByEmail throws AP_INSUFFICIENT_SCOPE (people/match not on this plan)', async () => {
    const connector = new ApolloConnector()
    await connector.connect({ apiKey: 'key' })
    await expect(
      connector.enrichByEmail('test@example.com')
    ).rejects.toMatchObject({ name: 'ConnectorError', code: 'AP_INSUFFICIENT_SCOPE' })
  })
})

// ── Live tests (only when APOLLO_API_KEY is set) ──────────────────────────────

describe.skipIf(!LIVE)('ApolloConnector.enrichOrganizationByDomain — live API', () => {
  const apiKey = process.env.APOLLO_API_KEY!

  it('returns ApolloOrganizationMatch for stripe.com with correct revenue field name', async () => {
    const connector = new ApolloConnector()
    await connector.connect({ apiKey })
    const result = await connector.enrichOrganizationByDomain('stripe.com')
    expect(result).not.toBeNull()
    expect(result!.apolloOrgId).toBeTruthy()
    expect(result!.revenue).toBeTypeOf('number')      // organization_revenue
    expect(result!.employeeCount).toBeTypeOf('number') // estimated_num_employees
    expect(result!.location.country).toBeTruthy()      // top-level country
  })

  it('returns null for a nonsense domain (confirmed HTTP 200 + {} pattern)', async () => {
    const connector = new ApolloConnector()
    await connector.connect({ apiKey })
    const result = await connector.enrichOrganizationByDomain('zzz-no-such-company-xyz123.invalid')
    expect(result).toBeNull()
    // If this throws instead of returning null, the three-way distinction is broken
  })

  it('healthCheck returns ok=true with valid key', async () => {
    const connector = new ApolloConnector()
    await connector.connect({ apiKey })
    const health = await connector.healthCheck()
    expect(health.ok).toBe(true)
  })
})
