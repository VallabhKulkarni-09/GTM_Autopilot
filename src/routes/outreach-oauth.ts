/**
 * src/routes/outreach-oauth.ts
 *
 * OAuth2 setup routes for Outreach connector.
 * After the callback succeeds, tokens are persisted to connector_config
 * (org-scoped, RLS-protected) so the connector works across restarts.
 *
 * Routes:
 *   POST /api/outreach/oauth/start    → (JWT required) creates a server-side nonce,
 *                                       returns { authorizationUrl } as JSON.
 *                                       Dashboard JS does: window.location.href = authorizationUrl
 *   GET  /api/outreach/oauth/callback → (no JWT — browser redirect from Outreach)
 *                                       looks up and consumes nonce, exchanges code for tokens,
 *                                       redirects to dashboard with ?connected=outreach
 *
 * Security model:
 *   - org_id is NEVER in the URL or state parameter sent to Outreach.
 *   - state = a random 32-byte hex nonce, stored server-side in oauth_nonce table.
 *   - The callback resolves org_id by looking up the nonce, then deletes it.
 *   - A nonce that is expired, unknown, or already used → redirect to error page.
 *   - Cross-org: impossible — the nonce is created by the authenticated org's JWT.
 *
 * The registered callback URL with Outreach does NOT change:
 *   <PUBLIC_API_URL>/api/outreach/oauth/callback
 *
 * Env vars required:
 *   OUTREACH_CLIENT_ID
 *   OUTREACH_CLIENT_SECRET
 *   OUTREACH_REDIRECT_URI (= <PUBLIC_API_URL>/api/outreach/oauth/callback)
 *   DASHBOARD_URL (= <DASHBOARD_URL>)
 *
 * Status: CODE-COMPLETE-UNVERIFIED
 *   The nonce logic is tested with negative cases (replayed, expired, cross-org).
 *   The full OAuth round-trip cannot be verified until Outreach partner approval is granted.
 */

import { randomBytes } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { ConnectorError } from '../connectors/base.js'
import { OutreachErrorCode } from '../connectors/outreach/outreach.errors.js'
import type { OutreachTokenResponse } from '../connectors/outreach/outreach.types.js'
import { storeOAuthTokens } from '../repositories/connector-config.repository.js'
import { getDb } from '../db/client.js'

const OR_AUTHORIZE_URL = 'https://api.outreach.io/oauth/authorize'
const OR_TOKEN_URL     = 'https://api.outreach.io/oauth/token'

const REQUIRED_SCOPES = [
  'prospects.all',
  'sequences.all',
  'sequenceStates.all',
  'accounts.all',
  'mailboxes.read',
].join(' ')

/** Nonce TTL in milliseconds (10 minutes) */
const NONCE_TTL_MS = 10 * 60 * 1000

export async function outreachOAuthRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /api/outreach/oauth/start ─────────────────────────────────────────
  // JWT-authenticated. Extracts org_id from tenantContext (never from query string).
  // Creates a server-side nonce and returns the Outreach authorization URL as JSON.
  // The dashboard calls this endpoint, then redirects the browser to the returned URL.
  app.post('/start', async (req, reply) => {
    const orgId = (req as any).tenantContext?.organizationId
    if (!orgId) {
      return reply.status(401).send({ error: 'MISSING_TENANT', message: 'Valid JWT required', requestId: req.id })
    }

    const clientId    = process.env.OUTREACH_CLIENT_ID
    const redirectUri = process.env.OUTREACH_REDIRECT_URI

    if (!clientId || !redirectUri) {
      return reply.status(500).send({
        error: 'OUTREACH_NOT_CONFIGURED',
        message: 'OUTREACH_CLIENT_ID and OUTREACH_REDIRECT_URI must be set in env vars',
        requestId: req.id,
      })
    }

    // Generate a cryptographically random nonce (32 bytes = 64 hex chars)
    const nonce     = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString()

    // Store nonce server-side with org binding
    const { error: dbErr } = await getDb()
      .from('oauth_nonce')
      .insert({ organization_id: orgId, nonce, connector_name: 'outreach', expires_at: expiresAt })

    if (dbErr) {
      req.log.error({ dbErr }, '[outreach-oauth] Failed to store nonce')
      return reply.status(500).send({ error: 'NONCE_STORE_FAILED', message: 'Internal error — please retry', requestId: req.id })
    }

    // Build authorization URL with nonce as state (no org_id in URL)
    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  redirectUri,
      response_type: 'code',
      scope:         REQUIRED_SCOPES,
      state:         nonce,
    })

    return reply.send({ authorizationUrl: `${OR_AUTHORIZE_URL}?${params.toString()}` })
  })

  // ── GET /api/outreach/oauth/callback ───────────────────────────────────────
  // No JWT — this is a browser redirect from Outreach.
  // Looks up and consumes the nonce to get org_id, then exchanges code for tokens.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/callback',
    async (req, reply) => {
      const dashboardUrl = process.env.DASHBOARD_URL ?? 'http://localhost:3001'
      const { code, state: nonce, error } = req.query

      if (error) {
        return reply.redirect(`${dashboardUrl}/settings?error=outreach_denied`)
      }
      if (!code || !nonce) {
        return reply.redirect(`${dashboardUrl}/settings?error=outreach_missing_code`)
      }

      // ── Look up and consume the nonce ──────────────────────────────────────
      const { data: nonceRow, error: lookupErr } = await getDb()
        .from('oauth_nonce')
        .select('id, organization_id, expires_at')
        .eq('nonce', nonce)
        .eq('connector_name', 'outreach')
        .single()

      if (lookupErr || !nonceRow) {
        req.log.warn({ nonce }, '[outreach-oauth] Nonce not found — may be replayed or expired')
        return reply.redirect(`${dashboardUrl}/settings?error=outreach_invalid_state`)
      }

      // Reject expired nonces (belt-and-suspenders; the query could also filter this)
      if (new Date(nonceRow.expires_at) < new Date()) {
        // Delete expired row
        await getDb().from('oauth_nonce').delete().eq('id', nonceRow.id)
        req.log.warn({ nonce }, '[outreach-oauth] Nonce expired')
        return reply.redirect(`${dashboardUrl}/settings?error=outreach_nonce_expired`)
      }

      // Consume the nonce — single use. Delete BEFORE the token exchange to prevent
      // a replay attack if the token exchange call is slow.
      await getDb().from('oauth_nonce').delete().eq('id', nonceRow.id)

      const orgId = nonceRow.organization_id

      // ── Exchange authorization code for tokens ─────────────────────────────
      const clientId     = process.env.OUTREACH_CLIENT_ID
      const clientSecret = process.env.OUTREACH_CLIENT_SECRET
      const redirectUri  = process.env.OUTREACH_REDIRECT_URI

      if (!clientId || !clientSecret || !redirectUri) {
        return reply.redirect(`${dashboardUrl}/settings?error=outreach_not_configured`)
      }

      let tokens: OutreachTokenResponse
      try {
        const res = await fetch(OR_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id:     clientId,
            client_secret: clientSecret,
            redirect_uri:  redirectUri,
            grant_type:    'authorization_code',
            code,
          }).toString(),
        })
        if (!res.ok) {
          const raw = await res.text()
          throw new ConnectorError(
            'outreach', OutreachErrorCode.AUTH_FAILED, res.status, raw,
            'Outreach token exchange failed'
          )
        }
        tokens = await res.json() as OutreachTokenResponse
      } catch (err) {
        req.log.error({ err }, '[outreach-oauth] Token exchange failed')
        return reply.redirect(`${dashboardUrl}/settings?error=outreach_token_exchange_failed`)
      }

      // Persist tokens to connector_config (org-scoped)
      try {
        await storeOAuthTokens(orgId, 'outreach', {
          access_token:  tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at:    Date.now() + (tokens.expires_in ?? 7200) * 1000,
          scope:         tokens.scope,
        })
      } catch (err) {
        req.log.error({ err }, '[outreach-oauth] Failed to persist tokens to connector_config')
        return reply.redirect(`${dashboardUrl}/settings?error=outreach_token_storage_failed`)
      }

      req.log.info({ orgId }, '[outreach-oauth] Tokens stored successfully for org')
      return reply.redirect(`${dashboardUrl}/settings?connected=outreach`)
    }
  )
}
