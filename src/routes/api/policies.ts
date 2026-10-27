/**
 * policies.ts — GET /api/policies, PUT /api/policies/:id
 *
 * Returns organization-scoped policy rules.
 * Tenant middleware (on /api/*) guarantees organizationId is a verified UUID.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { getDb } from '../../db/client.js'

export async function policyRoutes(app: FastifyInstance) {
  // ── GET /api/policies ──────────────────────────────────────────────────────
  app.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page:      { type: 'integer', minimum: 1, default: 1 },
          limit:     { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          rule_type: { type: 'string' },
          is_active: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { organizationId } = request.tenantContext
    const { page = 1, limit = 50, rule_type, is_active } = request.query as any

    const from = (page - 1) * limit
    let query = getDb()
      .from('policy_rules')
      .select('id, rule_type, name, description, conditions, actions, priority, is_active, created_at, updated_at', { count: 'exact' })
      .eq('organization_id', organizationId)
      .order('priority', { ascending: true })
      .range(from, from + limit - 1)

    if (rule_type) query = (query as any).eq('rule_type', rule_type)
    if (is_active !== undefined) query = (query as any).eq('is_active', is_active)

    const { data, count, error } = await (query as any)
    if (error) {
      return reply.status(500).send({
        error: 'POLICY_FETCH_FAILED',
        message: 'Failed to load policy rules',
        requestId: request.id,
      })
    }

    // Map DB rows to PolicyRule shape matching dashboard types/api.ts
    const rules = (data ?? []).map((row: any) => ({
      id: row.id,
      rule_type: row.rule_type,
      name: row.name,
      conditions_summary: row.description ?? row.name,
      // Same field the worker reads for the SLA deadline (seeded in default-policies.ts)
      sla_minutes: row.rule_type === 'sla' && typeof row.actions?.sla_minutes === 'number' ? row.actions.sla_minutes : undefined,
      queue_assigned: row.actions?.queue_name ?? row.actions?.queue ?? undefined,
    }))

    return reply.send(rules)
  })

  // ── PUT /api/policies/:id ──────────────────────────────────────────────────
  app.put('/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        properties: {
          is_active:   { type: 'boolean' },
          priority:    { type: 'integer', minimum: 1 },
          name:        { type: 'string', maxLength: 255 },
          description: { type: 'string' },
          // Response time (rule_type 'sla' only). New leads use it; leads already in flight keep their deadline.
          sla_minutes: { type: 'integer', minimum: 1, maximum: 10080 },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { organizationId } = request.tenantContext
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>
    const db = getDb()
    const notFound = () => reply.status(404).send({
      error: 'POLICY_NOT_FOUND',
      message: `Policy rule ${id} not found in this organization`,
      requestId: request.id,
    })

    const { data: current, error: readErr } = await db
      .from('policy_rules')
      .select('id, rule_type, version, actions')
      .eq('organization_id', organizationId)   // cross-tenant safety
      .eq('id', id)
      .maybeSingle()
    if (readErr || !current) return notFound()

    // Only allow whitelisted fields to be updated
    const allowedFields = ['is_active', 'priority', 'name', 'description']
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const field of allowedFields) {
      if (body[field] !== undefined) updates[field] = body[field]
    }
    if (body.sla_minutes !== undefined) {
      if (current.rule_type !== 'sla') {
        return reply.status(400).send({
          error: 'POLICY_FIELD_NOT_ALLOWED',
          message: 'Response time can only be set on the response-time rule.',
          requestId: request.id,
        })
      }
      updates.actions = { ...(current.actions ?? {}), sla_minutes: body.sla_minutes }
    }
    // A new version, so decision snapshots show which settings a lead was handled with.
    updates.version = current.version + 1

    const { data, error } = await db
      .from('policy_rules')
      .update(updates)
      .eq('organization_id', organizationId)   // cross-tenant safety
      .eq('id', id)
      .eq('version', current.version)          // concurrent save → conflict, not a silent overwrite
      .select('id, rule_type, name, description, priority, is_active, version, actions, updated_at')
      .maybeSingle()

    if (error) return notFound()
    if (!data) {
      return reply.status(409).send({
        error: 'POLICY_VERSION_CONFLICT',
        message: 'Someone else changed this setting at the same time. Reload the page and try again.',
        requestId: request.id,
      })
    }

    return reply.send({
      id: data.id, rule_type: data.rule_type, name: data.name, description: data.description,
      priority: data.priority, is_active: data.is_active, version: data.version, updated_at: data.updated_at,
      sla_minutes: data.rule_type === 'sla' ? data.actions?.sla_minutes : undefined,
    })
  })
}
