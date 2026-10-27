/**
 * salesloft.connector.ts
 * Salesloft connector implementing Connector<SalesloftConfig>.
 *
 * Auth: Salesloft uses OAuth2 (authorization_code flow).
 * Access tokens are short-lived. Refresh tokens rotate on use.
 * Transparent refresh: on 401, calls refreshAccessToken() once, then retries.
 *
 * TERMINOLOGY (critical — wrong field names are the bug class that hits every session):
 *   People        — what Outreach calls "Prospects" (/v2/people)
 *   Cadences      — what Outreach calls "Sequences" (/v2/cadences)
 *   CadenceMemberships — enrolling a Person in a Cadence (/v2/cadence_memberships)
 *
 * Env vars read by createSalesloftConnector():
 *   SALESLOFT_CLIENT_ID
 *   SALESLOFT_CLIENT_SECRET
 *   SALESLOFT_ACCESS_TOKEN
 *   SALESLOFT_REFRESH_TOKEN
 *   SALESLOFT_REDIRECT_URI
 *
 * Non-negotiables:
 *   - ConnectorError is the only error type thrown
 *   - All write methods require an idempotencyKey
 *   - organization_id scoping enforced at the repository layer (not here)
 *   - createSalesloftConnector() returns null (never throws) when env vars missing
 */

import { Connector, ConnectorError, ConnectorHealth, withRetry } from '../base.js'
import { SalesloftErrorCode } from './salesloft.errors.js'
import type {
  SalesloftConfig, SalesloftPerson, SalesloftCadence,
  SalesloftCadenceMembership, SalesloftTokenResponse,
  CreatePersonInput,
  SalesloftApiResponse, SalesloftApiListResponse,
} from './salesloft.types.js'

const SL_BASE      = 'https://api.salesloft.com/v2'
const SL_TOKEN_URL = 'https://accounts.salesloft.com/oauth/token'

export class SalesloftConnector implements Connector<SalesloftConfig> {
  readonly name    = 'salesloft' as const
  readonly version = '1.0.0'
  private config: SalesloftConfig | null = null
  /**
   * Called after every successful token refresh with the new tokens.
   * Injected at connect() time by the caller. Keeps repository access out of the connector.
   */
  private onTokenRefresh?: (tokens: { access_token: string; refresh_token: string; expires_at: number; scope?: string }) => Promise<void>

  async connect(
    config: SalesloftConfig,
    onTokenRefresh?: (tokens: { access_token: string; refresh_token: string; expires_at: number; scope?: string }) => Promise<void>
  ): Promise<void> {
    this.config = { ...config }
    this.onTokenRefresh = onTokenRefresh
  }

  async disconnect(): Promise<void> {
    this.config = null
  }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now()
    try {
      const res = await this.fetchWithAuth(
        `${SL_BASE}/cadences?per_page=1`,
        { signal: AbortSignal.timeout(8_000) }
      )
      if (!res.ok) throw new Error(`Status ${res.status}`)
      return { ok: true, latencyMs: Date.now() - start, lastChecked: new Date() }
    } catch (err) {
      return {
        ok: false, latencyMs: Date.now() - start,
        lastChecked: new Date(), error: String(err),
      }
    }
  }

  // ── Public Methods ──────────────────────────────────────────────────────────

  /** Returns null (not throws) when person not found by email. */
  async getPersonByEmail(email: string): Promise<SalesloftPerson | null> {
    return withRetry(this.name, SalesloftErrorCode.PERSON_SEARCH_FAILED, async () => {
      this.assertConnected()
      const res = await this.fetchWithAuth(
        `${SL_BASE}/people?filter[email_address]=${encodeURIComponent(email)}&per_page=1`
      )
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, SalesloftErrorCode.PERSON_SEARCH_FAILED, res.status, raw,
          `Salesloft person search failed for ${email}`
        )
      }
      const data = await res.json() as SalesloftApiListResponse<SalesloftPerson>
      return data.data.length === 0 ? null : data.data[0]
    })
  }

  async createPerson(input: CreatePersonInput, idempotencyKey: string): Promise<SalesloftPerson> {
    return withRetry(this.name, SalesloftErrorCode.PERSON_CREATE_FAILED, async () => {
      this.assertConnected()
      const body = {
        email_address: input.email_address,
        first_name:    input.first_name,
        last_name:     input.last_name,
        title:         input.title,
        phone:         input.phone,
        // Salesloft does not have a native idempotency key field;
        // use the custom person note field to carry the key for traceability
        person_notes:  `idempotency_key:${idempotencyKey}`,
        ...(input.owner_id ? { owner_id: input.owner_id } : {}),
      }
      const res = await this.fetchWithAuth(`${SL_BASE}/people`, {
        method: 'POST',
        body:   JSON.stringify(body),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, SalesloftErrorCode.PERSON_CREATE_FAILED, res.status, raw,
          'Failed to create Salesloft person'
        )
      }
      const data = await res.json() as SalesloftApiResponse<SalesloftPerson>
      return data.data
    })
  }

  /**
   * Enrolls a Person in a Cadence via POST /v2/cadence_memberships.
   *
   * Returns the CadenceMembership (id used as the external evidence ID,
   * matching how Outreach's sequenceState.id is captured).
   *
   * Salesloft API reference:
   *   POST /v2/cadence_memberships
   *   Body: { cadence_membership: { person_id, cadence_id, user_id? } }
   */
  async enrollInCadence(
    personId: number,
    cadenceId: number,
    idempotencyKey: string
  ): Promise<SalesloftCadenceMembership> {
    return withRetry(this.name, SalesloftErrorCode.CADENCE_ENROLL_FAILED, async () => {
      this.assertConnected()
      const body = {
        cadence_membership: {
          person_id:  personId,
          cadence_id: cadenceId,
        },
      }
      console.log(`[salesloft] enrollInCadence personId=${personId} cadenceId=${cadenceId} key=${idempotencyKey}`)
      const res = await this.fetchWithAuth(`${SL_BASE}/cadence_memberships`, {
        method: 'POST',
        body:   JSON.stringify(body),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, SalesloftErrorCode.CADENCE_ENROLL_FAILED, res.status, raw,
          `Failed to enroll person ${personId} in cadence ${cadenceId}`
        )
      }
      const data = await res.json() as SalesloftApiResponse<SalesloftCadenceMembership>
      return data.data
    })
  }

  /** Lists all active (non-archived) cadences for the authenticated user. */
  async getActiveCadences(): Promise<SalesloftCadence[]> {
    return withRetry(this.name, SalesloftErrorCode.CADENCE_LIST_FAILED, async () => {
      this.assertConnected()
      const res = await this.fetchWithAuth(`${SL_BASE}/cadences?filter[archived]=false&per_page=100`)
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, SalesloftErrorCode.CADENCE_LIST_FAILED, res.status, raw,
          'Failed to list Salesloft cadences'
        )
      }
      const data = await res.json() as SalesloftApiListResponse<SalesloftCadence>
      return data.data
    })
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Wrapper around fetch that:
   *   1. Injects Authorization + Content-Type headers
   *   2. On 401 → calls refreshAccessToken() once, then retries
   *   Never retries more than once (no infinite refresh loops).
   */
  private async fetchWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: { ...this.authHeaders(), ...(init.headers as Record<string, string> ?? {}) },
    })
    if (res.status === 401) {
      await this.refreshAccessToken()
      return fetch(url, {
        ...init,
        headers: { ...this.authHeaders(), ...(init.headers as Record<string, string> ?? {}) },
      })
    }
    return res
  }

  /**
   * Exchanges the stored refresh_token for a new access_token.
   * Updates this.config in-place.
   * Salesloft rotates refresh tokens — always store the new refresh token.
   * Throws ConnectorError(AUTH_FAILED) if refresh fails.
   */
  private async refreshAccessToken(): Promise<void> {
    this.assertConnected()
    const cfg = this.config!
    const res = await fetch(SL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        grant_type:    'refresh_token',
        redirect_uri:  process.env.SALESLOFT_REDIRECT_URI ?? '',
      }).toString(),
    })
    if (!res.ok) {
      const raw = await res.text()
      throw new ConnectorError(
        this.name, SalesloftErrorCode.AUTH_FAILED, res.status, raw,
        'Salesloft access token refresh failed'
      )
    }
    const tokens = await res.json() as SalesloftTokenResponse
    cfg.accessToken  = tokens.access_token
    cfg.refreshToken = tokens.refresh_token  // Salesloft rotates refresh tokens
    console.log('[salesloft] Access token refreshed successfully')

    // Persist refreshed tokens via callback (injected at connect() time).
    if (this.onTokenRefresh) {
      try {
        await this.onTokenRefresh({
          access_token:  tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at:    Date.now() + (tokens.expires_in ?? 7200) * 1000,
          scope:         tokens.scope,
        })
      } catch (persistErr) {
        console.error(`[salesloft] onTokenRefresh callback failed — tokens refreshed in-memory only: ${persistErr}`)
      }
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization:  `Bearer ${this.config!.accessToken}`,
      'Content-Type': 'application/json',
    }
  }

  private assertConnected(): void {
    if (!this.config) {
      throw new ConnectorError(
        this.name, SalesloftErrorCode.AUTH_FAILED, 401, null,
        'SalesloftConnector: call connect() before any API operation'
      )
    }
  }
}

/**
 * createSalesloftConnector — reads all required env vars.
 * Returns null (never throws) when any required env var is missing,
 * so the workflow degrades gracefully without crashing.
 */
export function createSalesloftConnector(): SalesloftConnector | null {
  const clientId     = process.env.SALESLOFT_CLIENT_ID
  const clientSecret = process.env.SALESLOFT_CLIENT_SECRET
  const accessToken  = process.env.SALESLOFT_ACCESS_TOKEN
  const refreshToken = process.env.SALESLOFT_REFRESH_TOKEN

  if (!clientId || !clientSecret || !accessToken || !refreshToken) {
    console.warn(
      '[salesloft] One or more env vars missing ' +
      '(SALESLOFT_CLIENT_ID, SALESLOFT_CLIENT_SECRET, SALESLOFT_ACCESS_TOKEN, ' +
      'SALESLOFT_REFRESH_TOKEN) — connector unavailable'
    )
    return null
  }

  const c = new SalesloftConnector()
  c.connect({ clientId, clientSecret, accessToken, refreshToken })
  return c
}
