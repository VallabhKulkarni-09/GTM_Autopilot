/**
 * zoominfo.connector.ts
 * ZoomInfo enrichment connector implementing Connector<ZoomInfoConfig>.
 *
 * Auth: JWT — NOT OAuth2. ZoomInfo uses a proprietary JWT authentication:
 *   POST https://api.zoominfo.com/authenticate { username, password } → { jwt }
 *   Tokens expire after 60 minutes. No refresh token provided — must re-authenticate.
 *   Re-auth happens automatically when token is within 5 minutes of expiry.
 *
 * Role in GTM Autopilot:
 *   Enrichment, parallel to Clearbit. Adds evidence row source_type='zoominfo_enrichment'.
 *   Does NOT replace Clearbit — runs alongside it. Qualification agent uses whichever
 *   source has higher confidence. This is an explicit product decision.
 *
 * Env vars read by createZoomInfoConnector():
 *   ZOOMINFO_USERNAME
 *   ZOOMINFO_PASSWORD
 *
 * Non-negotiables:
 *   - ConnectorError is the only error type thrown
 *   - Returns null (not throws) when no enrichment data found
 *   - createZoomInfoConnector() returns null when env vars missing
 *
 * ⚠️ CREDENTIAL ACCESS NOTE:
 *   ZoomInfo access is typically sales-gated. This connector is complete but
 *   has NOT been verified live — blocked on real ZoomInfo account credentials.
 */

import { Connector, ConnectorError, ConnectorHealth, withRetry } from '../base.js'
import { ZoomInfoErrorCode } from './zoominfo.errors.js'
import type {
  ZoomInfoConfig, ZoomInfoAuthResponse,
  ZoomInfoPerson, ZoomInfoCompany,
  ZoomInfoContactSearchRequest, ZoomInfoCompanySearchRequest,
  ZoomInfoSearchResponse,
} from './zoominfo.types.js'

const ZI_BASE     = 'https://api.zoominfo.com'
const ZI_AUTH_URL = `${ZI_BASE}/authenticate`

// Contact output fields — only request what qualification needs
const CONTACT_OUTPUT_FIELDS = [
  'id', 'firstName', 'lastName', 'email', 'directPhone',
  'jobTitle', 'jobFunction', 'seniorityLevel', 'managementLevel',
  'companyId', 'companyName', 'companyWebsite',
  'companyRevenue', 'companyEmployeeCount', 'companyIndustry',
  'city', 'state', 'country',
]

// Company output fields
const COMPANY_OUTPUT_FIELDS = [
  'id', 'name', 'website', 'revenue', 'revenueRange',
  'employeeCount', 'industry', 'subIndustry', 'sicCode',
  'city', 'state', 'country', 'zipCode', 'phone', 'founded',
]

export class ZoomInfoConnector implements Connector<ZoomInfoConfig> {
  readonly name    = 'zoominfo' as const
  readonly version = '1.0.0'

  private config:      ZoomInfoConfig | null = null
  private jwt:         string | null = null
  private jwtExpiresAt: number = 0   // epoch ms

  async connect(config: ZoomInfoConfig): Promise<void> {
    this.config = { ...config }
    await this.authenticate()
  }

  async disconnect(): Promise<void> {
    this.config = null
    this.jwt = null
    this.jwtExpiresAt = 0
  }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now()
    try {
      // Attempt to get a valid JWT — if auth works, connector is healthy
      await this.getValidJwt()
      return { ok: true, latencyMs: Date.now() - start, lastChecked: new Date() }
    } catch (err) {
      return {
        ok: false, latencyMs: Date.now() - start,
        lastChecked: new Date(), error: String(err),
      }
    }
  }

  // ── Public Methods ──────────────────────────────────────────────────────────

  /**
   * Enriches a contact by email address.
   * Returns null when ZoomInfo has no data for this email (not throws).
   */
  async enrichByEmail(email: string): Promise<ZoomInfoPerson | null> {
    return withRetry(this.name, ZoomInfoErrorCode.PERSON_ENRICH_FAILED, async () => {
      const jwt = await this.getValidJwt()
      const body: ZoomInfoContactSearchRequest = {
        outputFields:    CONTACT_OUTPUT_FIELDS,
        matchPersonInput: [{ emailAddress: email }],
      }
      const res = await fetch(`${ZI_BASE}/search/contact`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, ZoomInfoErrorCode.PERSON_ENRICH_FAILED, res.status, raw,
          `ZoomInfo contact enrichment failed for ${email}`
        )
      }
      const data = await res.json() as ZoomInfoSearchResponse<ZoomInfoPerson>
      const result = data?.data?.result?.[0]
      if (!result || result.matchStatus !== 'full_match' || !result.data?.length) {
        return null  // no match — not an error
      }
      return result.data[0]
    })
  }

  /**
   * Enriches a company by domain.
   * Returns null when ZoomInfo has no data for this domain (not throws).
   */
  async enrichByDomain(domain: string): Promise<ZoomInfoCompany | null> {
    return withRetry(this.name, ZoomInfoErrorCode.COMPANY_ENRICH_FAILED, async () => {
      const jwt = await this.getValidJwt()
      const body: ZoomInfoCompanySearchRequest = {
        outputFields: COMPANY_OUTPUT_FIELDS,
        companyInput: [{ websiteURL: domain }],
      }
      const res = await fetch(`${ZI_BASE}/search/company`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, ZoomInfoErrorCode.COMPANY_ENRICH_FAILED, res.status, raw,
          `ZoomInfo company enrichment failed for domain ${domain}`
        )
      }
      const data = await res.json() as ZoomInfoSearchResponse<ZoomInfoCompany>
      const result = data?.data?.result?.[0]
      if (!result || result.matchStatus !== 'full_match' || !result.data?.length) {
        return null
      }
      return result.data[0]
    })
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Returns a valid JWT. Re-authenticates if expired or within 5 minutes of expiry.
   * ZoomInfo does not provide refresh tokens — re-auth is the only option.
   */
  private async getValidJwt(): Promise<string> {
    if (!this.config) {
      throw new ConnectorError(
        this.name, ZoomInfoErrorCode.AUTH_FAILED, 401, null,
        'ZoomInfoConnector: call connect() before any API operation'
      )
    }
    // Re-auth if expired or within 5 minutes of expiry
    const fiveMinMs = 5 * 60 * 1000
    if (!this.jwt || Date.now() >= this.jwtExpiresAt - fiveMinMs) {
      await this.authenticate()
    }
    return this.jwt!
  }

  /**
   * Authenticates with ZoomInfo using username + password.
   * Stores the JWT and sets expiry to 55 minutes from now
   * (tokens expire at 60 minutes; 55 min gives 5 min buffer).
   */
  private async authenticate(): Promise<void> {
    if (!this.config) {
      throw new ConnectorError(
        this.name, ZoomInfoErrorCode.AUTH_FAILED, 401, null,
        'ZoomInfoConnector: config not set'
      )
    }
    let res: Response
    try {
      res = await fetch(ZI_AUTH_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          username: this.config.username,
          password: this.config.password,
        }),
        signal: AbortSignal.timeout(8_000),
      })
    } catch (err: any) {
      // Network error, ECONNREFUSED, AbortError, etc. — never leak as raw TypeError
      throw new ConnectorError(
        this.name, ZoomInfoErrorCode.AUTH_FAILED, 0, String(err),
        `ZoomInfo authentication network error: ${err?.message ?? String(err)}`
      )
    }
    if (!res.ok) {
      const raw = await res.text()
      throw new ConnectorError(
        this.name, ZoomInfoErrorCode.AUTH_FAILED, res.status, raw,
        'ZoomInfo authentication failed'
      )
    }
    const data = await res.json() as ZoomInfoAuthResponse
    if (!data.jwt) {
      throw new ConnectorError(
        this.name, ZoomInfoErrorCode.AUTH_FAILED, 200, data,
        'ZoomInfo authentication returned no JWT'
      )
    }
    this.jwt = data.jwt
    this.jwtExpiresAt = Date.now() + 55 * 60 * 1000  // 55 min (tokens expire at 60 min)
    console.log('[zoominfo] JWT obtained successfully')
  }
}

/**
 * createZoomInfoConnector — reads required env vars.
 * Returns null (never throws) when any required env var is missing.
 */
export function createZoomInfoConnector(): ZoomInfoConnector | null {
  const username = process.env.ZOOMINFO_USERNAME
  const password = process.env.ZOOMINFO_PASSWORD

  if (!username || !password) {
    console.warn(
      '[zoominfo] ZOOMINFO_USERNAME and ZOOMINFO_PASSWORD must be set — connector unavailable'
    )
    return null
  }

  const c = new ZoomInfoConnector()
  // connect() is called lazily on first enrichByEmail/enrichByDomain call
  // to avoid blocking startup on ZoomInfo auth latency
  c.connect({ username, password }).catch(err => {
    console.warn(`[zoominfo] Initial auth failed: ${err.message} — will retry on first use`)
  })
  return c
}
