/**
 * connectors.ts — v1 connections: HubSpot, Salesforce, Apollo only.
 *
 *   GET  /api/connectors              → status of each connection (no secrets, no live calls)
 *   POST /api/connectors/:name/test   → try credentials live (body fields; blank secret fields
 *                                        fall back to the saved ones). Nothing is stored.
 *   POST /api/connectors/:name/save   → test, then store encrypted (admin; enforced in app.ts)
 *
 * Errors are returned as { error: CODE, message: plain language } — see connector error codes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { HubSpotConnector }    from '../../connectors/hubspot/hubspot.connector.js'
import { SalesforceConnector } from '../../connectors/salesforce/salesforce.connector.js'
import { ApolloConnector }     from '../../connectors/apollo/apollo.connector.js'
import { ConnectorError }      from '../../connectors/base.js'
import { invalidateConnectors } from '../../connectors/factory.js'
import { friendlyError } from '../../connectors/error-messages.js'
import {
  V1_CONNECTORS,
  type V1ConnectorName,
  type StoredCredentials,
  describeConnector,
  loadConnectorCredentials,
  saveConnectorCredentials,
  recordHealth,
  findOrgByHubspotPortal,
} from '../../repositories/connector-credentials.repository.js'

type Body = Record<string, unknown>

export type TestOutcome =
  | { ok: true; latencyMs: number; credentials: StoredCredentials<V1ConnectorName>; details: Record<string, unknown> }
  | { ok: false; latencyMs: number; error: string; message: string }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Merge typed body fields over saved credentials (so admins can re-test without retyping secrets). */
async function buildCredentials(orgId: string, name: V1ConnectorName, body: Body): Promise<StoredCredentials<V1ConnectorName> | { missing: string[] }> {
  const saved = await loadConnectorCredentials(orgId, name).catch(() => null) as any
  const pick = (key: string, from: 'secrets' | 'public') => str(body[key]) || str(saved?.[from]?.[key])
  const missing: string[] = []
  const need = (label: string, v: string) => { if (!v) missing.push(label); return v }

  switch (name) {
    case 'hubspot': {
      const apiKey = need('Private app access token', pick('apiKey', 'secrets'))
      const webhookSecret = need('App client secret', pick('webhookSecret', 'secrets'))
      return missing.length ? { missing } : { public: { portal_id: '' }, secrets: { apiKey, webhookSecret } }
    }
    case 'salesforce': {
      const instanceUrl = need('Salesforce URL', pick('instanceUrl', 'public'))
      const clientId = need('Consumer key', pick('clientId', 'secrets'))
      const clientSecret = need('Consumer secret', pick('clientSecret', 'secrets'))
      const sandbox = typeof body.sandbox === 'boolean' ? body.sandbox : body.sandbox === 'true' || Boolean(saved?.public?.sandbox)
      if (instanceUrl && !/^https:\/\/[^\s/]+$/.test(instanceUrl.replace(/\/$/, ''))) {
        missing.push('Salesforce URL (must look like https://yourcompany.my.salesforce.com)')
      }
      return missing.length ? { missing } : { public: { instanceUrl: instanceUrl.replace(/\/$/, ''), sandbox }, secrets: { clientId, clientSecret } }
    }
    case 'apollo': {
      const apiKey = need('API key', pick('apiKey', 'secrets'))
      return missing.length ? { missing } : { public: {}, secrets: { apiKey } }
    }
  }
}

function failure(start: number, err: unknown): TestOutcome {
  if (err instanceof ConnectorError) {
    return { ok: false, latencyMs: Date.now() - start, error: err.code, message: err.message }
  }
  return { ok: false, latencyMs: Date.now() - start, error: 'CONNECTION_FAILED', message: 'Could not connect. Check the details and try again.' }
}

/** Live check. HubSpot also learns the portal ID; Apollo checks enrichment access. */
export async function testCredentials(name: V1ConnectorName, creds: StoredCredentials<V1ConnectorName>): Promise<TestOutcome> {
  const start = Date.now()
  try {
    switch (name) {
      case 'hubspot': {
        const c = creds as StoredCredentials<'hubspot'>
        const hs = new HubSpotConnector()
        await hs.connect(c.secrets)
        const { portalId } = await hs.getAccountInfo()
        const withPortal: StoredCredentials<'hubspot'> = { public: { portal_id: String(portalId) }, secrets: c.secrets }
        return { ok: true, latencyMs: Date.now() - start, credentials: withPortal, details: { portal_id: String(portalId) } }
      }
      case 'salesforce': {
        const c = creds as StoredCredentials<'salesforce'>
        const sf = new SalesforceConnector()
        await sf.connect({ ...c.public, ...c.secrets })   // fetches an OAuth token
        const health = await sf.healthCheck()
        if (!health.ok) return { ok: false, latencyMs: Date.now() - start, error: 'SF_QUERY_FAILED', message: health.error ?? 'Salesforce query failed' }
        return { ok: true, latencyMs: Date.now() - start, credentials: c, details: {} }
      }
      case 'apollo': {
        const c = creds as StoredCredentials<'apollo'>
        const ap = new ApolloConnector()
        await ap.connect(c.secrets)
        await ap.enrichOrganizationByDomain('apollo.io')   // throws ConnectorError on auth/scope problems
        return { ok: true, latencyMs: Date.now() - start, credentials: c, details: { enrichment: true } }
      }
    }
  } catch (err) {
    return failure(start, err)
  }
}

type Deps = { test: typeof testCredentials }

export function createConnectorRoutes(deps: Deps = { test: testCredentials }) {
  return async function connectorRoutes(app: FastifyInstance) {
    const nameParam = {
      type: 'object', required: ['name'],
      properties: { name: { type: 'string', enum: [...V1_CONNECTORS] } },
    }

    app.get('/', async (request, reply) => {
      const { organizationId } = request.tenantContext
      const rows = await Promise.all(V1_CONNECTORS.map(async name => {
        const d = await describeConnector(organizationId, name)
        const status = !d.configured ? 'not_connected' : d.healthStatus === 'error' ? 'needs_attention' : 'connected'
        return {
          name,
          status,
          details: d.public,
          lastChecked: d.lastCheckedAt,
        }
      }))
      return reply.send(rows)
    })

    async function run(request: FastifyRequest<{ Params: { name: V1ConnectorName }; Body: Body }>, reply: FastifyReply, save: boolean) {
      const { organizationId } = request.tenantContext
      const { name } = request.params
      const creds = await buildCredentials(organizationId, name, request.body ?? {})
      if ('missing' in creds) {
        return reply.status(400).send({ error: 'MISSING_FIELDS', message: `Please fill in: ${creds.missing.join(', ')}.`, requestId: request.id })
      }

      const outcome = await deps.test(name, creds)
      if (!outcome.ok) {
        if (save) await recordHealth(organizationId, name, false)
        const f = friendlyError(outcome.error)
        request.log.info({ connector: name, code: outcome.error, detail: outcome.message }, 'connector test failed')
        return reply.send({ ok: false, latencyMs: outcome.latencyMs, error: outcome.error, message: f.title, fix: f.fix })
      }

      if (save) {
        if (name === 'hubspot') {
          const portalId = (outcome.credentials as StoredCredentials<'hubspot'>).public.portal_id
          const owner = await findOrgByHubspotPortal(portalId)
          if (owner && owner !== organizationId) {
            return reply.status(409).send({ error: 'PORTAL_IN_USE', message: 'This HubSpot account is already connected to another workspace.', requestId: request.id })
          }
        }
        await saveConnectorCredentials(organizationId, name, outcome.credentials as never)
        await recordHealth(organizationId, name, true)
        invalidateConnectors(organizationId)
      }
      return reply.send({ ok: true, latencyMs: outcome.latencyMs, saved: save, details: outcome.details })
    }

    app.post<{ Params: { name: V1ConnectorName }; Body: Body }>('/:name/test',
      { schema: { params: nameParam, body: { type: 'object' } } }, (req, reply) => run(req, reply, false))
    app.post<{ Params: { name: V1ConnectorName }; Body: Body }>('/:name/save',
      { schema: { params: nameParam, body: { type: 'object' } } }, (req, reply) => run(req, reply, true))
  }
}

export const connectorRoutes = createConnectorRoutes()
