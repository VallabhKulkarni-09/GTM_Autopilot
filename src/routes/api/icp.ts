/**
 * icp.ts — "Ideal customer" settings.
 *   GET  /api/icp          current config (any member)
 *   PUT  /api/icp          save config, bumps policy version (admin)
 *   POST /api/icp/preview  "Would this lead qualify?" — scores a sample lead, writes nothing (any member)
 *
 * organizationId comes only from request.tenantContext (verified server-side).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin } from '../../middleware/tenant-context.js'
import { getActiveIcpPolicy, updateIcpPolicy, type IcpPolicyRow } from '../../repositories/icp-policy.repository.js'
import { parseIcpConfig, IcpConfigError, type IcpConfig } from '../../agents/qualification/icp-config.js'
import { scoreIcp } from '../../agents/qualification/rules.js'
import type { Company, Lead } from '../../domain/db-types.js'

export const FIT_LABELS = { tier_1: 'Great fit', tier_2: 'Good fit', not_icp: 'Not a fit' } as const

function missing(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({
    error: 'ICP_POLICY_MISSING',
    message: 'This workspace has no ideal customer settings yet.',
    requestId: request.id,
  })
}

function invalid(request: FastifyRequest, reply: FastifyReply, e: IcpConfigError) {
  return reply.status(400).send({ error: 'ICP_CONFIG_INVALID', message: e.message, issues: e.issues, requestId: request.id })
}

function present(row: IcpPolicyRow, config: IcpConfig) {
  return { id: row.id, version: row.version, updatedAt: row.updated_at, config }
}

const shortText = { type: ['string', 'null'], maxLength: 320 }

export async function icpRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    const row = await getActiveIcpPolicy(request.tenantContext.organizationId)
    if (!row) return missing(request, reply)
    try {
      return reply.send(present(row, parseIcpConfig(row.conditions)))
    } catch (e) {
      if (e instanceof IcpConfigError) return reply.status(422).send({ error: 'ICP_CONFIG_INVALID', message: e.message, issues: e.issues, requestId: request.id })
      throw e
    }
  })

  app.put('/', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['config', 'version'],
        properties: { config: { type: 'object' }, version: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { organizationId } = request.tenantContext
    const body = request.body as { config: unknown; version: number }
    let config: IcpConfig
    try { config = parseIcpConfig(body.config) } catch (e) {
      if (e instanceof IcpConfigError) return invalid(request, reply, e)
      throw e
    }
    const row = await getActiveIcpPolicy(organizationId)
    if (!row) return missing(request, reply)
    if (row.version !== body.version) {
      return reply.status(409).send({ error: 'ICP_VERSION_CONFLICT', message: 'Someone else changed these settings. Refresh to see the latest.', requestId: request.id })
    }
    const saved = await updateIcpPolicy(organizationId, row.id, row.version, config as unknown as Record<string, unknown>)
    if (!saved) {
      return reply.status(409).send({ error: 'ICP_VERSION_CONFLICT', message: 'Someone else changed these settings. Refresh to see the latest.', requestId: request.id })
    }
    return reply.send(present(saved, config))
  })

  app.post('/preview', {
    schema: {
      body: {
        type: 'object',
        required: ['lead'],
        properties: {
          config: { type: 'object' },
          lead: {
            type: 'object',
            properties: { email: shortText, title: shortText, source: shortText, country: shortText },
            additionalProperties: false,
          },
          company: {
            type: ['object', 'null'],
            properties: {
              industry: shortText,
              country: shortText,
              employee_count: { type: ['integer', 'null'], minimum: 0 },
            },
            additionalProperties: false,
          },
        },
      },
    },
  }, async (request, reply) => {
    const { organizationId } = request.tenantContext
    const body = request.body as {
      config?: unknown
      lead: { email?: string | null; title?: string | null; source?: string | null; country?: string | null }
      company?: { industry?: string | null; country?: string | null; employee_count?: number | null } | null
    }

    // Unsaved edits from the form take precedence; otherwise use the saved policy.
    let config: IcpConfig
    try {
      if (body.config !== undefined) config = parseIcpConfig(body.config)
      else {
        const row = await getActiveIcpPolicy(organizationId)
        if (!row) return missing(request, reply)
        config = parseIcpConfig(row.conditions)
      }
    } catch (e) {
      if (e instanceof IcpConfigError) return invalid(request, reply, e)
      throw e
    }

    const now = new Date().toISOString()
    const lead = {
      id: 'preview', organization_id: organizationId, email: body.lead.email ?? '',
      first_name: null, last_name: null, title: body.lead.title ?? null, phone: null,
      stage: 'new', source: body.lead.source ?? null, company_id: null, raw_payload: null,
      country: body.lead.country ?? null,
      form_submitted_at: now, created_at: now, updated_at: now,
    } as unknown as Lead
    const company = body.company
      ? ({
          id: 'preview', organization_id: organizationId, name: null, domain: null,
          industry: body.company.industry ?? null, employee_count: body.company.employee_count ?? null,
          country: body.company.country ?? null, raw_payload: null, created_at: now, updated_at: now,
        } as unknown as Company)
      : null

    const result = scoreIcp(lead, company, config)
    return reply.send({ ...result, fit_label: FIT_LABELS[result.icp_tier] })
  })
}
