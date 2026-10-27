/**
 * hubspot.connector.test.ts
 * verifyWebhookSignature is tested WITHOUT credentials (pure crypto).
 * API tests skipped if HUBSPOT_API_KEY is not set.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { createHash, createHmac } from 'crypto'
import { HubSpotConnector } from '../hubspot.connector.js'
import { ConnectorError } from '../../base.js'

const hasCredentials = Boolean(process.env.HUBSPOT_API_KEY)

// ─── Webhook signature — always runs (no credentials needed) ─────────────────

describe('HubSpotConnector.verifyWebhookSignature (pure crypto)', () => {
  const connector = new HubSpotConnector()
  const secret = 'test-secret-12345'
  const payload = JSON.stringify({ eventId: 'abc', subscriptionType: 'contact.creation' })
  // HubSpot v1: SHA256(secret + rawBody) — NOT HMAC
  const validSig = createHash('sha256').update(secret + payload).digest('hex')

  it('returns true for a valid signature', () => {
    expect(connector.verifyWebhookSignature(payload, validSig, secret)).toBe(true)
  })

  it('returns false for a tampered payload', () => {
    const tampered = payload + 'extra'
    expect(connector.verifyWebhookSignature(tampered, validSig, secret)).toBe(false)
  })

  it('returns false for a wrong secret', () => {
    expect(connector.verifyWebhookSignature(payload, validSig, 'wrong-secret')).toBe(false)
  })

  it('returns false for an empty signature', () => {
    expect(connector.verifyWebhookSignature(payload, '', secret)).toBe(false)
  })

  it('returns false for an empty payload', () => {
    expect(connector.verifyWebhookSignature('', validSig, secret)).toBe(false)
  })

  it('returns false for an empty secret', () => {
    expect(connector.verifyWebhookSignature(payload, validSig, '')).toBe(false)
  })

  it('is synchronous (not a Promise)', () => {
    const result = connector.verifyWebhookSignature(payload, validSig, secret)
    expect(result).not.toBeInstanceOf(Promise)
    expect(typeof result).toBe('boolean')
  })
})

// ─── API tests — skipped without credentials ──────────────────────────────────

describe.skipIf(!hasCredentials)('HubSpotConnector (live API)', () => {
  let connector: HubSpotConnector

  beforeAll(async () => {
    connector = new HubSpotConnector()
    await connector.connect({
      apiKey: process.env.HUBSPOT_API_KEY!,
      webhookSecret: process.env.HUBSPOT_WEBHOOK_SECRET!,
    })
  })

  it('healthCheck returns ok: true', async () => {
    const health = await connector.healthCheck()
    expect(health.ok).toBe(true)
  })

  it('getContactByEmail returns null for unknown email', async () => {
    const result = await connector.getContactByEmail('definitely-not-real@no-domain-gtmtest.invalid')
    expect(result).toBeNull()
  })

  it('getContactByEmail returns HubSpotContact for existing email', async () => {
    // This test requires a known contact email in your HubSpot sandbox
    const email = process.env.HUBSPOT_TEST_CONTACT_EMAIL
    if (!email) return
    const contact = await connector.getContactByEmail(email)
    expect(contact).not.toBeNull()
    expect(contact!.id).toBeTruthy()
  })

  it('updateContact throws ConnectorError (not raw Error) for missing contact', async () => {
    await expect(
      connector.updateContact('00000000000', { properties: { firstname: 'X' } } as any, 'test:hs:update:bad')
    ).rejects.toThrow(ConnectorError)
  })

  it('updateLifecycleStage throws ConnectorError for missing contact', async () => {
    await expect(
      connector.updateLifecycleStage('00000000000', 'lead', 'test:hs:lifecycle:bad')
    ).rejects.toThrow(ConnectorError)
  })
})
