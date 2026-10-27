/**
 * apollo.connector.test.ts
 *
 * Tests for the ApolloConnector.
 *
 * IMPORTANT: enrichByEmail (people/match) is NOT authorized on the current Apollo plan.
 * It now throws AP_INSUFFICIENT_SCOPE immediately. Tests updated to reflect this.
 * See apollo-org.connector.test.ts for the organization enrichment tests.
 *
 * Tests here cover:
 * - enrichByEmail correctly throws AP_INSUFFICIENT_SCOPE (plan restriction documented)
 * - APOLLO_ENRICHMENT_CONFIDENCE constant value
 * - AP_NOT_CONNECTED when connect() not called
 */

import { describe, it, expect } from 'vitest'
import { ApolloConnector, APOLLO_ENRICHMENT_CONFIDENCE } from '../apollo.connector.js'

describe('ApolloConnector — plan restrictions (always run)', () => {
  it('enrichByEmail throws AP_INSUFFICIENT_SCOPE (people/match not on this plan)', async () => {
    // This plan only has organizations/enrich. people/match returns 403.
    // The connector now throws immediately rather than making a network call.
    const connector = new ApolloConnector()
    await connector.connect({ apiKey: 'any-key' })

    await expect(
      connector.enrichByEmail('test@example.com')
    ).rejects.toMatchObject({
      name:   'ConnectorError',
      source: 'apollo',
      code:   'AP_INSUFFICIENT_SCOPE',
    })
  })

  it('throws ConnectorError(AP_NOT_CONNECTED) when connect() not called before enrichOrganizationByDomain', async () => {
    const connector = new ApolloConnector()
    // No connect() call

    await expect(
      connector.enrichOrganizationByDomain('stripe.com')
    ).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'AP_NOT_CONNECTED',
    })
  })

  it('APOLLO_ENRICHMENT_CONFIDENCE is named static constant 0.85', () => {
    // Static, not dynamic: Apollo does not report per-field confidence.
    expect(APOLLO_ENRICHMENT_CONFIDENCE).toBe(0.85)
  })
})
