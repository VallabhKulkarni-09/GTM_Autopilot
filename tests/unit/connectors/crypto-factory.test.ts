import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomBytes } from 'crypto'
import { encryptJson, decryptJson, EncryptionKeyError } from '../../../src/connectors/crypto.js'
import { createConnectorFactory, invalidateConnectors, resolveHubspotPortal } from '../../../src/connectors/factory.js'

const KEY = randomBytes(32).toString('base64')

describe('crypto (AES-256-GCM)', () => {
  beforeEach(() => { process.env.APP_ENCRYPTION_KEY = KEY })

  it('round-trips a JSON value and never stores plaintext', () => {
    const enc = encryptJson({ apiKey: 'secret-value' })
    expect(enc.startsWith('v1:')).toBe(true)
    expect(enc).not.toContain('secret-value')
    expect(decryptJson(enc)).toEqual({ apiKey: 'secret-value' })
  })

  it('uses a fresh IV each time', () => {
    expect(encryptJson({ a: 1 })).not.toBe(encryptJson({ a: 1 }))
  })

  it('rejects tampered ciphertext', () => {
    const parts = encryptJson({ a: 1 }).split(':')
    const ct = Buffer.from(parts[3], 'base64'); ct[0] ^= 0xff
    parts[3] = ct.toString('base64')
    expect(() => decryptJson(parts.join(':'))).toThrow()
  })

  it('refuses to decrypt with a different key', () => {
    const enc = encryptJson({ a: 1 })
    process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    expect(() => decryptJson(enc)).toThrow()
  })

  it('throws loudly when the key is missing or the wrong length', () => {
    delete process.env.APP_ENCRYPTION_KEY
    expect(() => encryptJson({})).toThrow(EncryptionKeyError)
    process.env.APP_ENCRYPTION_KEY = Buffer.from('short').toString('base64')
    expect(() => encryptJson({})).toThrow(EncryptionKeyError)
  })
})

describe('connector factory — per-workspace isolation', () => {
  const store: Record<string, any> = {
    'org-a:apollo': { public: {}, secrets: { apiKey: 'key-a' } },
    'org-b:apollo': { public: {}, secrets: { apiKey: 'key-b' } },
  }
  const load = vi.fn(async (org: string, name: string) => store[`${org}:${name}`] ?? null)
  const getConnectors = createConnectorFactory({ load: load as any })

  beforeEach(() => { invalidateConnectors('org-a'); invalidateConnectors('org-b'); load.mockClear() })

  it('builds each org\'s connector from that org\'s credentials only', async () => {
    const a = await getConnectors('org-a').apollo()
    const b = await getConnectors('org-b').apollo()
    expect((a as any).config.apiKey).toBe('key-a')
    expect((b as any).config.apiKey).toBe('key-b')
    expect(load).toHaveBeenCalledWith('org-a', 'apollo')
    expect(load).toHaveBeenCalledWith('org-b', 'apollo')
  })

  it('returns null when the workspace has not connected the tool', async () => {
    expect(await getConnectors('org-a').hubspot()).toBeNull()
    expect(await getConnectors('org-c').apollo()).toBeNull()
  })

  it('caches per org and reloads after invalidation', async () => {
    await getConnectors('org-a').apollo()
    await getConnectors('org-a').apollo()
    expect(load).toHaveBeenCalledTimes(1)
    invalidateConnectors('org-a')
    await getConnectors('org-a').apollo()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed load', async () => {
    load.mockRejectedValueOnce(new Error('db down'))
    await expect(getConnectors('org-a').apollo()).rejects.toThrow('db down')
    expect(await getConnectors('org-a').apollo()).not.toBeNull()
  })
})

describe('resolveHubspotPortal', () => {
  it('returns the owning workspace and its webhook secret', async () => {
    const r = await resolveHubspotPortal('123', {
      findOrg: async () => 'org-a',
      load: async () => ({ public: { portal_id: '123' }, secrets: { apiKey: 'k', webhookSecret: 'whs' } }) as any,
    })
    expect(r).toEqual({ organizationId: 'org-a', webhookSecret: 'whs' })
  })

  it('returns null for an unknown portal', async () => {
    expect(await resolveHubspotPortal('999', { findOrg: async () => null, load: vi.fn() as any })).toBeNull()
  })
})
