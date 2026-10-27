/**
 * outreach.ts — Outreach (Apollo Sequences) settings.
 *   GET /api/outreach           { id, version, updatedAt, config }  the org's outreach policy
 *   PUT /api/outreach           { config, version } → save (admin; optimistic version check)
 *   GET /api/outreach/options   { sequences, emailAccounts } live from the workspace's Apollo
 *
 * Admin-only writes are enforced by ADMIN_WRITE_PREFIXES in app.ts.
 * organization_id always comes from request.tenantContext.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ConnectorError } from '../../connectors/base.js'
import { friendlyError } from '../../connectors/error-messages.js'
import { getConnectors } from '../../connectors/factory.js'
import type { ApolloEmailAccount, ApolloSequence } from '../../connectors/apollo/apollo.types.js'
import { listActivePolicies, updatePolicy, type PolicyRowLite } from '../../repositories/reps.repository.js'
import { OutreachConfigError, parseOutreachConfig, validateForSave, type OutreachConfig } from '../../policies/outreach-policy.js'

type OutreachOptions = { sequences: ApolloSequence[]; emailAccounts: ApolloEmailAccount[] }

type Deps = { loadApolloOptions: (organizationId: string) => Promise<OutreachOptions | null> }

const defaultDeps: Deps = {
  async loadApolloOptions(organizationId) {
    const ap = await getConnectors(organizationId).apollo()
    if (!ap) return null
    const [sequences, emailAccounts] = await Promise.all([ap.listSequences(), ap.listEmailAccounts()])
    return { sequences, emailAccounts }
  },
}

function err(request: FastifyRequest, reply: FastifyReply, status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return reply.status(status).send({ error, message, requestId: request.id, ...extra })
}

const MISSING = 'This workspace has no outreach settings yet.'

function present(rule: PolicyRowLite & { updated_at?: string }, config: OutreachConfig) {
  return { id: rule.id, version: rule.version, config }
}

const idString = { type: 'string', minLength: 1, maxLength: 200 }
// No additionalProperties:false inside oneOf branches: Fastify's ajv runs with
// removeAdditional, which would strip fields while trying a non-matching branch.
// parseOutreachConfig rebuilds clean objects, so extra keys are never stored.
const tierSchema = {
  oneOf: [
    { type: 'null' },
    { type: 'object', required: ['mode'], properties: { mode: { const: 'manual' } } },
    {
      type: 'object', required: ['mode', 'sequence_id', 'sequence_name'],
      properties: { mode: { const: 'sequence' }, sequence_id: idString, sequence_name: { type: 'string', maxLength: 300 } },
    },
  ],
}
const putBody = {
  type: 'object', required: ['config', 'version'], additionalProperties: false,
  properties: {
    version: { type: 'integer', minimum: 1 },
    config: {
      type: 'object', required: ['email_account', 'tiers'], additionalProperties: false,
      properties: {
        email_account: {
          oneOf: [
            { type: 'null' },
            { type: 'object', required: ['id', 'email'], properties: { id: idString, email: { type: 'string', maxLength: 320 } } },
          ],
        },
        tiers: {
          type: 'object', required: ['tier_1', 'tier_2'], additionalProperties: false,
          properties: { tier_1: tierSchema, tier_2: tierSchema },
        },
      },
    },
  },
}

export function createOutreachRoutes(deps: Deps = defaultDeps) {
  return async function outreachRoutes(app: FastifyInstance) {
    app.get('/', async (request, reply) => {
      const [rule] = await listActivePolicies(request.tenantContext.organizationId, 'outreach')
      if (!rule) return err(request, reply, 404, 'OUTREACH_POLICY_MISSING', MISSING)
      try {
        return present(rule, parseOutreachConfig(rule.actions))
      } catch (e) {
        if (e instanceof OutreachConfigError) {
          return err(request, reply, 422, 'OUTREACH_POLICY_INVALID', 'The saved outreach settings are not valid. Pick them again and save.', { issues: e.issues })
        }
        throw e
      }
    })

    app.put('/', { schema: { body: putBody } }, async (request, reply) => {
      const { organizationId } = request.tenantContext
      const { config: raw, version } = request.body as { config: unknown; version: number }
      let config: OutreachConfig
      try {
        config = parseOutreachConfig(raw)
      } catch (e) {
        if (e instanceof OutreachConfigError) return err(request, reply, 400, 'OUTREACH_POLICY_INVALID', 'Some outreach settings are not valid.', { issues: e.issues })
        throw e
      }
      const issues = validateForSave(config)
      if (issues.length) return err(request, reply, 400, 'OUTREACH_POLICY_INVALID', 'Some outreach settings are not valid.', { issues })

      const [rule] = await listActivePolicies(organizationId, 'outreach')
      if (!rule) return err(request, reply, 404, 'OUTREACH_POLICY_MISSING', MISSING)
      if (rule.version !== version) return conflict(request, reply)
      const saved = await updatePolicy(organizationId, 'outreach', rule.id, rule.version, { actions: config as unknown as Record<string, unknown> })
      if (!saved) return conflict(request, reply)
      return present(saved, config)
    })

    app.get('/options', async (request, reply) => {
      let options: OutreachOptions | null
      try {
        options = await deps.loadApolloOptions(request.tenantContext.organizationId)
      } catch (e) {
        if (e instanceof ConnectorError) {
          const f = friendlyError(e.code)
          return err(request, reply, 502, e.code, f.title, { fix: f.fix })
        }
        throw e
      }
      if (!options) return err(request, reply, 409, 'APOLLO_NOT_CONNECTED', 'Connect Apollo on the Connections page first.')
      return options
    })
  }
}

function conflict(request: FastifyRequest, reply: FastifyReply) {
  return err(request, reply, 409, 'POLICY_VERSION_CONFLICT', 'Someone else changed this. Refresh to see the latest.')
}
