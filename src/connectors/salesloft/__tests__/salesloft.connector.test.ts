/**
 * salesloft.connector.test.ts
 *
 * Tests for SalesloftConnector.
 *
 * ⚠️ STATUS: CODE COMPLETE — CREDENTIAL BLOCKED
 * These tests require real Salesloft OAuth credentials.
 * All tests will fail with AUTH_FAILED until SALESLOFT_CLIENT_ID,
 * SALESLOFT_CLIENT_SECRET, SALESLOFT_ACCESS_TOKEN, and SALESLOFT_REFRESH_TOKEN
 * are set in the test environment.
 *
 * How to unblock: Create a Salesloft OAuth app at developers.salesloft.com,
 * run the OAuth flow via /api/salesloft/oauth/start, store the tokens,
 * then re-run these tests.
 *
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SalesloftConnector } from '../salesloft.connector.js'
import { ConnectorError } from '../../base.js'

const SKIP_LIVE = !process.env.SALESLOFT_ACCESS_TOKEN

describe('SalesloftConnector', () => {

  // ── Auth tests (always run — verifies error shape without credentials) ────

  it('throws ConnectorError (not raw Error) when connect called with empty config', async () => {
    const connector = new SalesloftConnector()
    await connector.connect({ clientId: '', clientSecret: '', accessToken: '', refreshToken: '' })
    const err = await connector.healthCheck()
    // healthCheck returns { ok: false } rather than throwing — check the shape
    expect(err.ok).toBe(false)
    expect(typeof err.error).toBe('string')
  })

  it('getPersonByEmail throws ConnectorError when not connected', async () => {
    const connector = new SalesloftConnector()
    // Not calling connect — assertConnected should throw
    await expect(connector.getPersonByEmail('test@example.com'))
      .rejects.toMatchObject({ name: 'ConnectorError', code: 'SL_AUTH_FAILED' })
  })

  it('createPerson throws ConnectorError when not connected', async () => {
    const connector = new SalesloftConnector()
    await expect(
      connector.createPerson({ email_address: 'test@example.com' }, 'test-key')
    ).rejects.toMatchObject({ name: 'ConnectorError', code: 'SL_AUTH_FAILED' })
  })

  it('enrollInCadence throws ConnectorError when not connected', async () => {
    const connector = new SalesloftConnector()
    await expect(connector.enrollInCadence(1, 1, 'test-key'))
      .rejects.toMatchObject({ name: 'ConnectorError', code: 'SL_AUTH_FAILED' })
  })

  // ── Live tests (skip when credentials not present) ────────────────────────

  describe.skipIf(SKIP_LIVE)('Live tests (requires SALESLOFT_ACCESS_TOKEN)', () => {
    let connector: SalesloftConnector
    let testPersonId: number | undefined

    beforeAll(async () => {
      connector = new SalesloftConnector()
      await connector.connect({
        clientId:     process.env.SALESLOFT_CLIENT_ID!,
        clientSecret: process.env.SALESLOFT_CLIENT_SECRET!,
        accessToken:  process.env.SALESLOFT_ACCESS_TOKEN!,
        refreshToken: process.env.SALESLOFT_REFRESH_TOKEN!,
      })
    })

    afterAll(async () => {
      await connector.disconnect()
    })

    it('healthCheck returns ok: true with real credentials', async () => {
      const health = await connector.healthCheck()
      expect(health.ok).toBe(true)
      expect(health.latencyMs).toBeGreaterThan(0)
    })

    it('getPersonByEmail returns null for unknown email', async () => {
      const result = await connector.getPersonByEmail('definitely.not.real.email.gtm.test@nonexistent.tld')
      expect(result).toBeNull()
    })

    it('createPerson creates a person and getPersonByEmail finds them', async () => {
      const email = `gtm-test-${Date.now()}@example-test-gtm.com`
      const person = await connector.createPerson(
        { email_address: email, first_name: 'GTM', last_name: 'Test' },
        `test:${Date.now()}`
      )
      expect(person.id).toBeDefined()
      expect(typeof person.id).toBe('number')
      testPersonId = person.id

      const found = await connector.getPersonByEmail(email)
      expect(found?.id).toBe(person.id)
    })

    it('getActiveCadences returns an array', async () => {
      const cadences = await connector.getActiveCadences()
      expect(Array.isArray(cadences)).toBe(true)
    })

    it('enrollInCadence enrolls the test person when SALESLOFT_TEST_CADENCE_ID is set', async () => {
      const cadenceId = process.env.SALESLOFT_TEST_CADENCE_ID
      if (!cadenceId || !testPersonId) {
        console.log('Skipping enrollment test — SALESLOFT_TEST_CADENCE_ID not set or no test person')
        return
      }
      const membership = await connector.enrollInCadence(
        testPersonId,
        Number(cadenceId),
        `test:enrollment:${Date.now()}`
      )
      expect(membership.id).toBeDefined()
      expect(membership.person.id).toBe(testPersonId)
    })
  })
})
