/**
 * hubspot.connector.ts
 * HubSpot connector implementing Connector<HubSpotConfig>.
 * Credentials: HUBSPOT_API_KEY, HUBSPOT_WEBHOOK_SECRET
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { Connector, ConnectorError, ConnectorHealth, withRetry } from '../base.js'
import { HubSpotErrorCode } from './hubspot.errors.js'
import type { HubSpotConfig, HubSpotContact, HubSpotSearchResponse } from './hubspot.types.js'

const HS_BASE = 'https://api.hubapi.com'

export class HubSpotConnector implements Connector<HubSpotConfig> {
  readonly name = 'hubspot' as const
  readonly version = '1.0.0'
  private config: HubSpotConfig | null = null

  async connect(config: HubSpotConfig): Promise<void> { this.config = config }
  async disconnect(): Promise<void> { this.config = null }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now()
    try {
      const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts?limit=1`, { headers: this.headers(), signal: AbortSignal.timeout(8_000) })
      if (!res.ok) throw new Error(`Status ${res.status}`)
      return { ok: true, latencyMs: Date.now() - start, lastChecked: new Date() }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, lastChecked: new Date(), error: String(err) }
    }
  }

  /**
   * Account details for the token's HubSpot account — used to learn the portal ID,
   * which is how incoming webhooks are matched to a workspace.
   * GET /account-info/v3/details → { portalId, accountType, timeZone, ... }
   */
  async getAccountInfo(): Promise<{ portalId: number; accountType?: string }> {
    return withRetry(this.name, HubSpotErrorCode.ACCOUNT_INFO_FAILED, async () => {
      this.assertConnected()
      let res: Response
      try {
        res = await fetch(`${HS_BASE}/account-info/v3/details`, { headers: this.headers(), signal: AbortSignal.timeout(8_000) })
      } catch (err) {
        throw new ConnectorError(this.name, HubSpotErrorCode.REQUEST_FAILED, 0, String(err), 'Could not reach HubSpot')
      }
      if (res.status === 401 || res.status === 403) {
        throw new ConnectorError(this.name, HubSpotErrorCode.AUTH_FAILED, res.status, await res.text(), 'HubSpot rejected the private app token')
      }
      if (!res.ok) {
        throw new ConnectorError(this.name, HubSpotErrorCode.ACCOUNT_INFO_FAILED, res.status, await res.text(), 'HubSpot account details request failed')
      }
      const data = await res.json() as { portalId?: number; accountType?: string }
      if (typeof data.portalId !== 'number') {
        throw new ConnectorError(this.name, HubSpotErrorCode.ACCOUNT_INFO_FAILED, res.status, data, 'HubSpot account details had no portalId')
      }
      return { portalId: data.portalId, accountType: data.accountType }
    })
  }

  /** Returns null (not throws) when contact is not found (404). */
  async getContactByEmail(email: string): Promise<HubSpotContact | null> {
    return withRetry(this.name, HubSpotErrorCode.CONTACT_SEARCH_FAILED, async () => {
      this.assertConnected()
      const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
          properties: ['email','firstname','lastname','jobtitle','phone','company','lifecyclestage','hs_lead_status'],
          limit: 1,
        }),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, HubSpotErrorCode.CONTACT_SEARCH_FAILED, res.status, raw, `HubSpot search failed for ${email}`)
      }
      const data = await res.json() as HubSpotSearchResponse
      return data.total === 0 ? null : data.results[0]
    })
  }

  /**
   * Fetch a contact by HubSpot object ID (the numeric ID from webhook payloads).
   * Returns null when not found. This is the primary lookup from webhook events
   * since HubSpot webhooks only contain objectId, not email/name.
   */
  async getContactById(objectId: number | string): Promise<HubSpotContact | null> {
    return withRetry(this.name, HubSpotErrorCode.CONTACT_SEARCH_FAILED, async () => {
      this.assertConnected()
      const props = 'email,firstname,lastname,jobtitle,phone,company,lifecyclestage,hs_lead_status,website'
      const res = await fetch(
        `${HS_BASE}/crm/v3/objects/contacts/${objectId}?properties=${props}`,
        { headers: this.headers() }
      )
      if (res.status === 404) return null
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, HubSpotErrorCode.CONTACT_SEARCH_FAILED, res.status, raw, `HubSpot getContactById failed for ${objectId}`)
      }
      const data = await res.json() as HubSpotContact
      return data
    })
  }

  async updateContact(id: string, data: Partial<HubSpotContact>, idempotencyKey: string): Promise<void> {
    await withRetry(this.name, HubSpotErrorCode.CONTACT_UPDATE_FAILED, async () => {
      this.assertConnected()
      const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/${id}`, {
        method: 'PATCH',
        headers: { ...this.headers(), 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ properties: data.properties ?? {} }),
      })
      if (res.status === 404) throw new ConnectorError(this.name, HubSpotErrorCode.CONTACT_NOT_FOUND, 404, '', `Contact ${id} not found`)
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, HubSpotErrorCode.CONTACT_UPDATE_FAILED, res.status, raw, `Failed to update contact ${id}`)
      }
    })
  }

  async updateLifecycleStage(contactId: string, stage: string, idempotencyKey: string): Promise<void> {
    await withRetry(this.name, HubSpotErrorCode.LIFECYCLE_STAGE_UPDATE_FAILED, async () => {
      this.assertConnected()
      const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { ...this.headers(), 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ properties: { lifecyclestage: stage } }),
      })
      if (res.status === 404) throw new ConnectorError(this.name, HubSpotErrorCode.CONTACT_NOT_FOUND, 404, '', `Contact ${contactId} not found`)
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, HubSpotErrorCode.LIFECYCLE_STAGE_UPDATE_FAILED, res.status, raw, `Failed to update lifecycle stage for ${contactId}`)
      }
    })
  }

  /**
   * SYNCHRONOUS. Pure crypto — never async, never calls HubSpot API.
   *
   * HubSpot v1 signature (x-hubspot-signature):
   *   SHA-256( clientSecret + rawRequestBody )
   *   NOT an HMAC — a plain hash of the concatenation.
   *
   * Reference: https://developers.hubspot.com/docs/api/webhooks#validate-requests
   */
  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    if (!payload || !signature || !secret) return false
    try {
      // HubSpot v1: SHA256(secret + body) — simple hash, not HMAC
      const expected = createHash('sha256').update(secret + payload).digest('hex')
      const sigBuf = Buffer.from(signature, 'hex')
      const expBuf = Buffer.from(expected, 'hex')
      if (sigBuf.length !== expBuf.length) return false
      return timingSafeEqual(sigBuf, expBuf)
    } catch { return false }
  }

  /**
   * HubSpot v3 signature (x-hubspot-signature-v3 + x-hubspot-request-timestamp):
   *   base64( HMAC-SHA256( clientSecret, method + fullUrl + rawBody + timestamp ) )
   * fullUrl is the Target URL HubSpot called (https://host/path?query).
   * Rejects timestamps older than 5 minutes (replay protection).
   * Reference: https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation
   */
  verifyWebhookSignatureV3(
    args: { method: string; url: string; rawBody: string; timestamp: string; signature: string; secret: string },
    nowMs: number = Date.now(),
  ): boolean {
    const { method, url, rawBody, timestamp, signature, secret } = args
    if (!signature || !timestamp || !secret) return false
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > 5 * 60_000) return false
    try {
      const expected = createHmac('sha256', secret).update(`${method}${url}${rawBody}${timestamp}`, 'utf8').digest()
      const given = Buffer.from(signature, 'base64')
      return given.length === expected.length && timingSafeEqual(given, expected)
    } catch { return false }
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config!.apiKey}`, 'Content-Type': 'application/json' }
  }

  private assertConnected(): void {
    if (!this.config) throw new ConnectorError(this.name, HubSpotErrorCode.AUTH_FAILED, 401, null, 'Call connect() first')
  }
}

export function createHubSpotConnector(): HubSpotConnector {
  const c = new HubSpotConnector()
  c.connect({ apiKey: process.env.HUBSPOT_API_KEY!, webhookSecret: process.env.HUBSPOT_WEBHOOK_SECRET! })
  return c
}
