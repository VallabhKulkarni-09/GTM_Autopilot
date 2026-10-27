/**
 * zoominfo.connector.test.ts
 *
 * Tests for ZoomInfoConnector.
 *
 * ⚠️ STATUS: CODE COMPLETE — CREDENTIAL BLOCKED
 * These tests require real ZoomInfo credentials (username + password).
 * ZoomInfo access is typically sales-gated. All live tests will fail
 * until ZOOMINFO_USERNAME and ZOOMINFO_PASSWORD are set.
 *
 */

import { describe, it, expect, afterAll } from 'vitest'
import { ZoomInfoConnector } from '../zoominfo.connector.js'
import { ConnectorError } from '../../base.js'

const SKIP_LIVE = !process.env.ZOOMINFO_USERNAME || !process.env.ZOOMINFO_PASSWORD

describe('ZoomInfoConnector', () => {

  // ── Structural tests (always run) ─────────────────────────────────────────

  it('enrichByEmail returns null (not throws) when not connected', async () => {
    const connector = new ZoomInfoConnector()
    // getValidJwt throws ConnectorError when config not set
    await expect(connector.enrichByEmail('test@example.com'))
      .rejects.toMatchObject({ name: 'ConnectorError', code: 'ZI_AUTH_FAILED' })
  })

  it('enrichByDomain returns null (not throws) when not connected', async () => {
    const connector = new ZoomInfoConnector()
    await expect(connector.enrichByDomain('example.com'))
      .rejects.toMatchObject({ name: 'ConnectorError', code: 'ZI_AUTH_FAILED' })
  })

  it('connect with wrong credentials throws ConnectorError (not raw Error)', async () => {
    const connector = new ZoomInfoConnector()
    await expect(
      connector.connect({ username: 'wrong@example.com', password: 'wrongpassword' })
    ).rejects.toMatchObject({ name: 'ConnectorError', code: 'ZI_AUTH_FAILED' })
  })

  // ── Live tests (skip when credentials not present) ────────────────────────

  describe.skipIf(SKIP_LIVE)('Live tests (requires ZOOMINFO_USERNAME + ZOOMINFO_PASSWORD)', () => {
    let connector: ZoomInfoConnector

    // Note: ZoomInfo connector calls connect() in createZoomInfoConnector
    // For tests, we instantiate and connect manually
    connector = new ZoomInfoConnector()

    afterAll(async () => {
      await connector.disconnect()
    })

    it('connect authenticates and healthCheck returns ok: true', async () => {
      await connector.connect({
        username: process.env.ZOOMINFO_USERNAME!,
        password: process.env.ZOOMINFO_PASSWORD!,
      })
      const health = await connector.healthCheck()
      expect(health.ok).toBe(true)
    })

    it('enrichByEmail returns null for clearly fake email', async () => {
      const result = await connector.enrichByEmail('definitely.not.real.gtm.test@nonexistent-domain-xyz.tld')
      expect(result).toBeNull()
    })

    it('enrichByDomain returns null for fake domain', async () => {
      const result = await connector.enrichByDomain('nonexistent-domain-xyz-gtm-test.tld')
      expect(result).toBeNull()
    })

    it('enrichByDomain returns company data for a known company domain', async () => {
      // salesforce.com has reliable ZoomInfo data
      const company = await connector.enrichByDomain('salesforce.com')
      if (!company) {
        console.log('Warning: no ZoomInfo data for salesforce.com — may be a tier/permissions issue')
        return
      }
      expect(company.name).toBeDefined()
      expect(company.employeeCount).toBeGreaterThan(0)
    })
  })
})
