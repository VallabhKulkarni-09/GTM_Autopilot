/**
 * app.ts — Fastify application factory.
 * Exported, NOT started here. server.ts does the listen() call.
 *
 * Middleware:
 *   - /api/* routes: tenantContextMiddleware (JWT required)
 *   - /webhooks/*: HMAC only, no JWT, no rate-limit (drop nothing)
 *
 * Security:
 *   - @fastify/helmet: sets security headers on all responses
 *   - @fastify/rate-limit: 100 req/min per IP on /api/* only
 */

import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { tenantContextMiddleware, requireAdmin } from './middleware/tenant-context.js'
import { webhookRoutes }       from './routes/webhooks.js'
import { leadRoutes }          from './routes/api/leads.js'
import { metricsRoutes }       from './routes/api/metrics.js'
import { connectorRoutes }     from './routes/api/connectors.js'
import { policyRoutes }        from './routes/api/policies.js'
import { meRoutes, workspaceRoutes } from './routes/api/workspaces.js'
import { icpRoutes } from './routes/api/icp.js'
import { createRepRoutes, territoryRoutes } from './routes/api/reps.js'
import { teamRoutes }          from './routes/api/team.js'
import { createOutreachRoutes } from './routes/api/outreach.js'
import { createPlayRoutes, createApprovalRoutes, createAttentionRoutes } from './routes/api/plays.js'
import { setupRoutes } from './routes/api/setup.js'
import { createTestLeadRoutes } from './routes/api/test-lead.js'
import { aiModelRoutes } from './routes/api/ai-model.js'

/** Non-GET requests under these prefixes are admin-only. */
export const ADMIN_WRITE_PREFIXES = ['/api/policies', '/api/connectors', '/api/team', '/api/reps', '/api/territories', '/api/outreach', '/api/plays', '/api/test-lead', '/api/setup', '/api/ai-model']

export function buildApp() {
  const app = Fastify({
    logger: true,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  })

  // ─── Security headers (all routes) ────────────────────────────────────────
  void app.register(helmet, { global: true })

  // ─── Rate limiting — API routes only (webhooks exempt) ────────────────────
  void app.register(rateLimit, {
    global: false,           // must be enabled per-route or per-plugin
    max: 100,
    timeWindow: '1 minute',
    skipOnError: true,
    keyGenerator: (request) => request.ip,
  })

  // ─── Auth — API routes only ────────────────────────────────────────────────
  // 1. Supabase user token → org + role from org_members (never from the request).
  // 2. Any write under an admin-only prefix requires role=admin.
  // onRequest (not preHandler): authenticate before body parsing/validation, so an
  // unauthorised caller learns nothing from validation errors.
  app.addHook('onRequest', async (request, reply) => {
    const url = request.routeOptions?.url
    if (!url?.startsWith('/api/')) return
    await tenantContextMiddleware(request, reply)
    if (reply.sent) return
    if (request.method !== 'GET' && ADMIN_WRITE_PREFIXES.some(p => url.startsWith(p))) {
      return requireAdmin(request, reply)
    }
  })

  // ─── Routes ────────────────────────────────────────────────────────────────
  // Webhooks: no rate-limit, no tenant middleware (HMAC only)
  app.register(webhookRoutes,       { prefix: '/webhooks' })

  // API routes: tenant middleware applied, rate-limited
  app.register(leadRoutes,          { prefix: '/api/leads' })
  app.register(metricsRoutes,       { prefix: '/api/metrics' })
  app.register(connectorRoutes,     { prefix: '/api/connectors' })
  app.register(policyRoutes,        { prefix: '/api/policies' })
  app.register(meRoutes,            { prefix: '/api/me' })
  app.register(workspaceRoutes,     { prefix: '/api/workspaces' })
  app.register(teamRoutes,          { prefix: '/api/team' })
  app.register(icpRoutes,           { prefix: '/api/icp' })
  app.register(createRepRoutes(),   { prefix: '/api/reps' })
  app.register(territoryRoutes,     { prefix: '/api/territories' })
  app.register(createOutreachRoutes(), { prefix: '/api/outreach' })
  app.register(createPlayRoutes(),      { prefix: '/api/plays' })
  app.register(createApprovalRoutes(),  { prefix: '/api/approvals' })
  app.register(createAttentionRoutes(), { prefix: '/api/attention' })
  app.register(setupRoutes,             { prefix: '/api/setup' })
  app.register(createTestLeadRoutes(),  { prefix: '/api/test-lead' })
  app.register(aiModelRoutes,           { prefix: '/api/ai-model' })

  // v1 scope is HubSpot + Salesforce + Apollo. The Outreach/Salesloft OAuth routes
  // (src/routes/*-oauth.ts) are intentionally NOT registered until those connectors return.


  // ─── Health check — required by Railway ───────────────────────────────────
  app.get('/health', { logLevel: 'silent' }, async (_req, reply) => {
    return reply.status(200).send({ status: 'ok', version: process.env.npm_package_version ?? '0.0.1', uptime: process.uptime() })
  })

  return app
}
