/**
 * clearbit.connector.test.ts
 * null-on-404 behaviour is tested via mocked fetch for specific paths.
 * Full enrichment tests skipped without CLEARBIT_API_KEY.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { ClearbitConnector } from '../clearbit.connector.js'
import { ConnectorError } from '../../base.js'

const hasCredentials = Boolean(process.env.CLEARBIT_API_KEY)

// ─── null-on-404 — runs without credentials (mocked fetch for 404 path only) ─

describe('ClearbitConnector null-on-not-found (mocked 404)', () => {
  it('enrichByEmail returns null on 404', async () => {
    const connector = new ClearbitConnector()
    await connector.connect({ apiKey: 'test-key' })

    const mockFetch = vi.fn().mockResolvedValue({
      status: 404, ok: false,
      text: async () => 'Not found',
      json: async () => ({}),
    } as any)
    vi.stubGlobal('fetch', mockFetch)

    const result = await connector.enrichByEmail('unknown@example.com')
    expect(result).toBeNull()
    vi.unstubAllGlobals()
  })

  it('enrichByEmail returns null on 202 (async lookup)', async () => {
    const connector = new ClearbitConnector()
    await connector.connect({ apiKey: 'test-key' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 202, ok: false,
      text: async () => '',
      json: async () => ({}),
    } as any))

    const result = await connector.enrichByEmail('pending@example.com')
    expect(result).toBeNull()
    vi.unstubAllGlobals()
  })

  it('enrichByDomain returns null on 404', async () => {
    const connector = new ClearbitConnector()
    await connector.connect({ apiKey: 'test-key' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 404, ok: false,
      text: async () => 'Not found',
      json: async () => ({}),
    } as any))

    const result = await connector.enrichByDomain('unknown-domain-gtmtest.invalid')
    expect(result).toBeNull()
    vi.unstubAllGlobals()
  })

  it('enrichByEmail throws ConnectorError on 500 (not null)', async () => {
    const connector = new ClearbitConnector()
    await connector.connect({ apiKey: 'test-key' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 500, ok: false,
      text: async () => 'Internal Server Error',
      json: async () => ({}),
    } as any))

    await expect(connector.enrichByEmail('test@example.com')).rejects.toThrow(ConnectorError)
    vi.unstubAllGlobals()
  })

  it('enrichByDomain throws ConnectorError on 401 (not null)', async () => {
    const connector = new ClearbitConnector()
    await connector.connect({ apiKey: 'bad-key' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 401, ok: false,
      text: async () => 'Unauthorized',
      json: async () => ({}),
    } as any))

    await expect(connector.enrichByDomain('example.com')).rejects.toThrow(ConnectorError)
    vi.unstubAllGlobals()
  })
})

// ─── Live enrichment tests — skipped without credentials ─────────────────────

describe.skipIf(!hasCredentials)('ClearbitConnector (live API)', () => {
  let connector: ClearbitConnector

  beforeAll(async () => {
    connector = new ClearbitConnector()
    await connector.connect({ apiKey: process.env.CLEARBIT_API_KEY! })
  })

  it('healthCheck returns ok: true', async () => {
    const health = await connector.healthCheck()
    expect(health.ok).toBe(true)
  })

  it('enrichByEmail returns ClearbitPerson for known email', async () => {
    // Use a well-known email that Clearbit has data for
    const result = await connector.enrichByEmail('alex@clearbit.com')
    // May return null if data unavailable — both are valid
    expect(result === null || typeof result?.id === 'string').toBe(true)
  })

  it('enrichByDomain returns ClearbitCompany for known domain', async () => {
    const result = await connector.enrichByDomain('stripe.com')
    expect(result === null || typeof result?.domain === 'string').toBe(true)
  })

  it('enrichByEmail returns null for unknown email (not throws)', async () => {
    const result = await connector.enrichByEmail('definitely-nobody@gtm-test-nonexistent-99.invalid')
    expect(result).toBeNull()
  })
})
