/**
 * outreach.connector.ts
 * Outreach connector implementing Connector<OutreachConfig>.
 *
 * Auth: Outreach uses OAuth2 (authorization_code flow).
 * Access tokens expire after ~2 hours. This connector handles refresh
 * transparently: on a 401, it calls refreshAccessToken() once, then retries.
 *
 * Env vars (read by createOutreachConnector()):
 *   OUTREACH_CLIENT_ID
 *   OUTREACH_CLIENT_SECRET
 *   OUTREACH_ACCESS_TOKEN
 *   OUTREACH_REFRESH_TOKEN
 *   OUTREACH_MAILBOX_ID     ← required for sequenceState creation
 *
 * Non-negotiables enforced here:
 *   - ConnectorError is the ONLY error type thrown from any public method
 *   - All write methods require an idempotencyKey parameter
 *   - mailboxId is always included in sequenceState creation (Outreach API requirement)
 *   - Token refresh happens at most once per request (no infinite refresh loops)
 */

import { Connector, ConnectorError, ConnectorHealth, withRetry } from '../base.js'
import { OutreachErrorCode } from './outreach.errors.js'
import type {
  OutreachConfig, OutreachProspect, OutreachSequence, OutreachSequenceState,
  OutreachTask, OutreachTokenResponse,
  CreateProspectInput, CreateTaskInput,
  OutreachApiResponse, OutreachApiListResponse,
} from './outreach.types.js'

const OR_BASE      = 'https://api.outreach.io/api/v2'
const OR_TOKEN_URL = 'https://api.outreach.io/oauth/token'

export class OutreachConnector implements Connector<OutreachConfig> {
  readonly name    = 'outreach' as const
  readonly version = '1.0.0'
  private config: OutreachConfig | null = null
  /**
   * Called after every successful token refresh with the new tokens.
   * Injected at construction time by the caller (first-touch.ts, OAuth routes).
   * Keeps repository access out of the connector layer.
   */
  private onTokenRefresh?: (tokens: { access_token: string; refresh_token: string; expires_at: number; scope?: string }) => Promise<void>

  async connect(
    config: OutreachConfig,
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
        `${OR_BASE}/sequences?page[size]=1`,
        { signal: AbortSignal.timeout(8_000) }
      )
      if (!res.ok) throw new Error(`Status ${res.status}`)
      return { ok: true, latencyMs: Date.now() - start, lastChecked: new Date() }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, lastChecked: new Date(), error: String(err) }
    }
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  /** Returns null (not throws) when prospect not found. */
  async getProspectByEmail(email: string): Promise<OutreachProspect | null> {
    return withRetry(this.name, OutreachErrorCode.PROSPECT_SEARCH_FAILED, async () => {
      this.assertConnected()
      const res = await this.fetchWithAuth(
        `${OR_BASE}/prospects?filter[emails]=${encodeURIComponent(email)}&page[size]=1`
      )
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, OutreachErrorCode.PROSPECT_SEARCH_FAILED, res.status, raw,
          `Outreach prospect search failed for ${email}`
        )
      }
      const data = await res.json() as OutreachApiListResponse<OutreachProspect>
      return data.data.length === 0 ? null : data.data[0]
    })
  }

  async createProspect(input: CreateProspectInput, idempotencyKey: string): Promise<OutreachProspect> {
    return withRetry(this.name, OutreachErrorCode.PROSPECT_CREATE_FAILED, async () => {
      this.assertConnected()
      const body = {
        data: {
          type: 'prospect',
          attributes: {
            emails:       [input.email],
            firstName:    input.firstName,
            lastName:     input.lastName,
            title:        input.title,
            phoneNumbers: input.phone ? [input.phone] : [],
            tags:         [`idempotency:${idempotencyKey}`],
          },
          relationships: input.ownerId ? {
            owner: { data: { type: 'user', id: input.ownerId } },
          } : undefined,
        },
      }
      const res = await this.fetchWithAuth(`${OR_BASE}/prospects`, {
        method: 'POST',
        body:   JSON.stringify(body),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, OutreachErrorCode.PROSPECT_CREATE_FAILED, res.status, raw,
          'Failed to create Outreach prospect'
        )
      }
      const data = await res.json() as OutreachApiResponse<OutreachProspect>
      return data.data
    })
  }

  /**
   * Enrolls a prospect in a sequence.
   *
   * IMPORTANT: Outreach API requires a mailbox relationship in the sequenceState
   * payload — without it the API returns 422. mailboxId is taken from
   * this.config.mailboxId (OUTREACH_MAILBOX_ID env var).
   *
   * Returns the created sequenceState (id is used as the external evidence ID).
   */
  async enrollInSequence(
    prospectId: string,
    sequenceId: string,
    idempotencyKey: string
  ): Promise<OutreachSequenceState> {
    return withRetry(this.name, OutreachErrorCode.SEQUENCE_ENROLL_FAILED, async () => {
      this.assertConnected()
      const body = {
        data: {
          type: 'sequenceState',
          attributes: {
            // tags carry the idempotency key so duplicate calls can be traced
            tags: [`idempotency:${idempotencyKey}`],
          },
          relationships: {
            prospect: { data: { type: 'prospect', id: prospectId } },
            sequence: { data: { type: 'sequence', id: sequenceId } },
            // mailbox is REQUIRED — omitting it returns 422 from Outreach
            mailbox:  { data: { type: 'mailbox',  id: this.config!.mailboxId } },
          },
        },
      }
      const res = await this.fetchWithAuth(`${OR_BASE}/sequenceStates`, {
        method: 'POST',
        body:   JSON.stringify(body),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, OutreachErrorCode.SEQUENCE_ENROLL_FAILED, res.status, raw,
          `Failed to enroll prospect ${prospectId} in sequence ${sequenceId}`
        )
      }
      const data = await res.json() as OutreachApiResponse<OutreachSequenceState>
      return data.data
    })
  }

  async getActiveSequences(prospectId: string): Promise<OutreachSequence[]> {
    return withRetry(this.name, OutreachErrorCode.SEQUENCE_LIST_FAILED, async () => {
      this.assertConnected()
      const res = await this.fetchWithAuth(
        `${OR_BASE}/sequenceStates?filter[prospect][id]=${prospectId}&filter[state]=active`
      )
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, OutreachErrorCode.SEQUENCE_LIST_FAILED, res.status, raw,
          `Failed to get sequences for prospect ${prospectId}`
        )
      }
      const data = await res.json() as OutreachApiListResponse<OutreachSequence>
      return data.data
    })
  }

  async createTask(
    prospectId: string,
    task: CreateTaskInput,
    idempotencyKey: string
  ): Promise<OutreachTask> {
    return withRetry(this.name, OutreachErrorCode.TASK_CREATE_FAILED, async () => {
      this.assertConnected()
      const body = {
        data: {
          type: 'task',
          attributes: {
            subject:  task.subject,
            taskType: task.taskType ?? 'action',
            dueAt:    task.dueAt,
            tags:     [`idempotency:${idempotencyKey}`],
          },
          relationships: {
            prospect: { data: { type: 'prospect', id: prospectId } },
          },
        },
      }
      const res = await this.fetchWithAuth(`${OR_BASE}/tasks`, {
        method: 'POST',
        body:   JSON.stringify(body),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(
          this.name, OutreachErrorCode.TASK_CREATE_FAILED, res.status, raw,
          `Failed to create task for prospect ${prospectId}`
        )
      }
      const data = await res.json() as OutreachApiResponse<OutreachTask>
      return data.data
    })
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Wrapper around fetch that:
   *   1. Injects Authorization + Content-Type headers
   *   2. On 401 → calls refreshAccessToken() once, then retries the original request
   *   Never retries more than once (no infinite refresh loops).
   */
  private async fetchWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: { ...this.authHeaders(), ...(init.headers as Record<string, string> ?? {}) },
    })

    if (res.status === 401) {
      // Token expired — refresh once, then retry
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
   * Updates this.config.accessToken in-place.
   * Throws ConnectorError(AUTH_FAILED) if refresh fails.
   */
  private async refreshAccessToken(): Promise<void> {
    this.assertConnected()
    const cfg = this.config!

    const res = await fetch(OR_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        grant_type:    'refresh_token',
        redirect_uri:  process.env.OUTREACH_REDIRECT_URI ?? '',
      }).toString(),
    })

    if (!res.ok) {
      const raw = await res.text()
      throw new ConnectorError(
        this.name, OutreachErrorCode.AUTH_FAILED, res.status, raw,
        'Outreach access token refresh failed'
      )
    }

    const tokens = await res.json() as OutreachTokenResponse
    cfg.accessToken  = tokens.access_token
    cfg.refreshToken = tokens.refresh_token  // Outreach rotates refresh tokens
    console.log('[outreach] Access token refreshed successfully')

    // Persist refreshed tokens via callback (injected at connect() time).
    // Failure here is logged but does not fail the request — the in-memory refresh succeeded.
    if (this.onTokenRefresh) {
      try {
        await this.onTokenRefresh({
          access_token:  tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at:    Date.now() + (tokens.expires_in ?? 7200) * 1000,
          scope:         tokens.scope,
        })
      } catch (persistErr) {
        console.error(`[outreach] onTokenRefresh callback failed — tokens refreshed in-memory only: ${persistErr}`)
      }
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization:  `Bearer ${this.config!.accessToken}`,
      'Content-Type': 'application/vnd.api+json',
    }
  }

  private assertConnected(): void {
    if (!this.config) {
      throw new ConnectorError(
        this.name, OutreachErrorCode.AUTH_FAILED, 401, null,
        'OutreachConnector: call connect() before any API operation'
      )
    }
  }
}

/**
 * createOutreachConnector — reads all 5 required env vars.
 * Returns null (not throws) when any required env var is missing,
 * so the action executor can degrade gracefully rather than crashing.
 */
export function createOutreachConnector(): OutreachConnector | null {
  const clientId     = process.env.OUTREACH_CLIENT_ID
  const clientSecret = process.env.OUTREACH_CLIENT_SECRET
  const accessToken  = process.env.OUTREACH_ACCESS_TOKEN
  const refreshToken = process.env.OUTREACH_REFRESH_TOKEN
  const mailboxId    = process.env.OUTREACH_MAILBOX_ID

  if (!clientId || !clientSecret || !accessToken || !refreshToken || !mailboxId) {
    console.warn(
      '[outreach] One or more env vars missing ' +
      '(OUTREACH_CLIENT_ID, OUTREACH_CLIENT_SECRET, OUTREACH_ACCESS_TOKEN, ' +
      'OUTREACH_REFRESH_TOKEN, OUTREACH_MAILBOX_ID) — connector unavailable'
    )
    return null
  }

  const c = new OutreachConnector()
  c.connect({ clientId, clientSecret, accessToken, refreshToken, mailboxId })
  return c
}
