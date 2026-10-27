/**
 * src/routes/salesloft-oauth.ts
 *
 * OAuth2 setup routes for Salesloft connector. Mirrors outreach-oauth.ts exactly.
 *
 * Routes:
 *   POST /api/salesloft/oauth/start    → (JWT required) creates server-side nonce,
 *                                        returns { authorizationUrl } as JSON.
 *   GET  /api/salesloft/oauth/callback → (no JWT — browser redirect from Salesloft)
 *                                        looks up and consumes nonce, exchanges code,
 *                                        redirects to dashboard with ?connected=salesloft
 *
 * The registered callback URL with Salesloft does NOT change:
 *   <PUBLIC_API_URL>/api/salesloft/oauth/callback
 *
 * Env vars required:
 *   SALESLOFT_CLIENT_ID
 *   SALESLOFT_CLIENT_SECRET
 *   SALESLOFT_REDIRECT_URI
 *   DASHBOARD_URL
 *
 * Status: CODE-COMPLETE-UNVERIFIED
 *   Nonce logic tested with negative cases (replayed, expired, cross-org).
 *   Full OAuth round-trip blocked on Salesloft App Portal approval.
 */

import { randomBytes } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { ConnectorError } from '../connectors/base.js'
import { SalesloftErrorCode } from '../connectors/salesloft/salesloft.errors.js'
import type { SalesloftTokenResponse } from '../connectors/salesloft/salesloft.types.js'
import { storeOAuthTokens } from '../repositories/connector-config.repository.js'
import { getDb } from '../db/client.js'

const SL_AUTHORIZE_URL = 'https://accounts.salesloft.com/oauth/authorize'
const SL_TOKEN_URL     = 'https://accounts.salesloft.com/oauth/token'

const REQUIRED_SCOPES = [
  'cadences.r',
  'cadences.w',
  'people.r',
  'people.w',
].join(' ')

const NONCE_TTL_MS = 10 * 60 * 1000

export async function salesloftOAuthRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /api/salesloft/oauth/start ─────────────────────────────────────────
  app.post('/start', async (req, reply) => {
    const orgId = (req as any).tenantContext?.organizationId
    if (!orgId) {
      return reply.status(401).send({ error: 'MISSING_TENANT', message: 'Valid JWT required', requestId: req.id })
    }

    const clientId    = process.env.SALESLOFT_CLIENT_ID
    const redirectUri = process.env.SALESLOFT_REDIRECT_URI

    if (!clientId || !redirectUri) {
      return reply.status(500).send({
        error: 'SALESLOFT_NOT_CONFIGURED',
        message: 'SALESLOFT_CLIENT_ID and SALESLOFT_REDIRECT_URI must be set in env vars',
        requestId: req.id,
      })
    }

    const nonce     = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString()

    const { error: dbErr } = await getDb()
      .from('oauth_nonce')
      .insert({ organization_id: orgId, nonce, connector_name: 'salesloft', expires_at: expiresAt })

    if (dbErr) {
      req.log.error({ dbErr }, '[salesloft-oauth] Failed to store nonce')
      return reply.status(500).send({ error: 'NONCE_STORE_FAILED', message: 'Internal error — please retry', requestId: req.id })
    }

    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  redirectUri,
      response_type: 'code',
      scope:         REQUIRED_SCOPES,
      state:         nonce,
    })

    return reply.send({ authorizationUrl: `${SL_AUTHORIZE_URL}?${params.toString()}` })
  })

  // ── GET /api/salesloft/oauth/callback ──────────────────────────────────────
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/callback',
    async (req, reply) => {
      const dashboardUrl = process.env.DASHBOARD_URL ?? 'http://localhost:3001'
      const { code, state: nonce, error } = req.query

      if (error) {
        return reply.redirect(`${dashboardUrl}/settings?error=salesloft_denied`)
      }
      if (!code || !nonce) {
        return reply.redirect(`${dashboardUrl}/settings?error=salesloft_missing_code`)
      }

      const { data: nonceRow, error: lookupErr } = await getDb()
        .from('oauth_nonce')
        .select('id, organization_id, expires_at')
        .eq('nonce', nonce)
        .eq('connector_name', 'salesloft')
        .single()

      if (lookupErr || !nonceRow) {
        req.log.warn({ nonce }, '[salesloft-oauth] Nonce not found — may be replayed or expired')
        return reply.redirect(`${dashboardUrl}/settings?error=salesloft_invalid_state`)
      }

      if (new Date(nonceRow.expires_at) < new Date()) {
        await getDb().from('oauth_nonce').delete().eq('id', nonceRow.id)
        req.log.warn({ nonce }, '[salesloft-oauth] Nonce expired')
        return reply.redirect(`${dashboardUrl}/settings?error=salesloft_nonce_expired`)
      }

      // Consume the nonce before token exchange (prevents replay on slow network)
      await getDb().from('oauth_nonce').delete().eq('id', nonceRow.id)

      const orgId = nonceRow.organization_id

      const clientId     = process.env.SALESLOFT_CLIENT_ID
      const clientSecret = process.env.SALESLOFT_CLIENT_SECRET
      const redirectUri  = process.env.SALESLOFT_REDIRECT_URI

      if (!clientId || !clientSecret || !redirectUri) {
        return reply.redirect(`${dashboardUrl}/settings?error=salesloft_not_configured`)
      }

      let tokens: SalesloftTokenResponse
      try {
        const res = await fetch(SL_TOKEN_URL, {
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
            'salesloft', SalesloftErrorCode.AUTH_FAILED, res.status, raw,
            'Salesloft token exchange failed'
          )
        }
        tokens = await res.json() as SalesloftTokenResponse
      } catch (err) {
        req.log.error({ err }, '[salesloft-oauth] Token exchange failed')
        return reply.redirect(`${dashboardUrl}/settings?error=salesloft_token_exchange_failed`)
      }

      try {
        await storeOAuthTokens(orgId, 'salesloft', {
          access_token:  tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at:    Date.now() + (tokens.expires_in ?? 7200) * 1000,
          scope:         tokens.scope,
        })
      } catch (err) {
        req.log.error({ err }, '[salesloft-oauth] Failed to persist tokens to connector_config')
        return reply.redirect(`${dashboardUrl}/settings?error=salesloft_token_storage_failed`)
      }

      req.log.info({ orgId }, '[salesloft-oauth] Tokens stored successfully for org')
      return reply.redirect(`${dashboardUrl}/settings?connected=salesloft`)
    }
  )
}
