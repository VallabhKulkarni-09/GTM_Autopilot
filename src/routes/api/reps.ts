/**
 * reps.ts — Reps & territories.
 *   GET   /api/reps                 list reps (Salesforce users we route to)
 *   POST  /api/reps/import          pull active users from the workspace's Salesforce (admin)
 *   PATCH /api/reps/:id             { available } — pause/resume a rep (admin)
 *   GET   /api/reps/settings        { maxOpenLeadsPerRep }
 *   PUT   /api/reps/settings        save it (admin)
 *   GET   /api/territories          list territories
 *   POST  /api/territories          create (admin)
 *   PUT   /api/territories/:id      update (admin)
 *   DELETE /api/territories/:id     switch off (admin; row kept for audit)
 *
 * Admin-only writes are enforced by ADMIN_WRITE_PREFIXES in app.ts.
 * The API exposes our rep IDs (external_identity.id), never Salesforce user IDs.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ConnectorError } from '../../connectors/base.js'
import { friendlyError } from '../../connectors/error-messages.js'
import { getConnectors } from '../../connectors/factory.js'
import type { SalesforceUser } from '../../connectors/salesforce/salesforce.types.js'
import {
  listReps, insertRep, updateRepMetadata, listActivePolicies, insertPolicy, updatePolicy,
  type RepRow, type RepMetadata, type PolicyRowLite,
} from '../../repositories/reps.repository.js'
import { MAX_OPEN_LEADS_LIMIT, readTerritory, territoryRow, territoryQueueName } from '../../policies/routing-policy.js'

type Deps = { loadSalesforceUsers: (organizationId: string) => Promise<SalesforceUser[] | null> }

const defaultDeps: Deps = {
  async loadSalesforceUsers(organizationId) {
    const sf = await getConnectors(organizationId).salesforce()
    return sf ? sf.getUsers({ isActive: true }) : null
  },
}

function err(request: FastifyRequest, reply: FastifyReply, status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return reply.status(status).send({ error, message, requestId: request.id, ...extra })
}

function presentRep(r: RepRow) {
  return {
    id: r.id,
    name: r.metadata?.name ?? '',
    email: r.metadata?.email ?? '',
    title: r.metadata?.title ?? null,
    available: r.metadata?.available === true,
    activeInSalesforce: r.metadata?.sf_active === true,
  }
}

const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

export function createRepRoutes(deps: Deps = defaultDeps) {
  return async function repRoutes(app: FastifyInstance) {
    app.get('/', async request => {
      const reps = await listReps(request.tenantContext.organizationId)
      return { reps: reps.map(presentRep) }
    })

    app.post('/import', async (request, reply) => {
      const { organizationId } = request.tenantContext
      let users: SalesforceUser[] | null
      try {
        users = await deps.loadSalesforceUsers(organizationId)
      } catch (e) {
        if (e instanceof ConnectorError) {
          const f = friendlyError(e.code)
          return err(request, reply, 502, e.code, f.title, { fix: f.fix })
        }
        throw e
      }
      if (!users) return err(request, reply, 409, 'SALESFORCE_NOT_CONNECTED', 'Connect Salesforce on the Settings page first.')

      const existing = await listReps(organizationId)
      const byExternal = new Map<string, RepRow[]>()
      for (const r of existing) byExternal.set(r.external_id, [...(byExternal.get(r.external_id) ?? []), r])
      const now = new Date().toISOString()
      let added = 0, updated = 0, deactivated = 0
      const seen = new Set<string>()

      for (const u of users) {
        if (!u.Id || seen.has(u.Id)) continue
        seen.add(u.Id)
        const rows = byExternal.get(u.Id)
        if (!rows) {
          await insertRep(organizationId, u.Id, { name: u.Name, email: u.Email ?? '', title: u.UserRole?.Name ?? null, available: true, sf_active: true, imported_at: now })
          added++
          continue
        }
        for (const r of rows) {
          const meta: RepMetadata = { ...r.metadata, name: u.Name, email: u.Email ?? '', title: u.UserRole?.Name ?? null, sf_active: true, available: r.metadata?.available === true, imported_at: now }
          await updateRepMetadata(organizationId, r.id, meta)
          updated++
        }
      }
      // Previously imported reps no longer active in Salesforce stop receiving leads.
      for (const r of existing) {
        if (!seen.has(r.external_id) && r.metadata?.sf_active !== false) {
          await updateRepMetadata(organizationId, r.id, { ...r.metadata, sf_active: false, available: r.metadata?.available === true })
          deactivated++
        }
      }
      const reps = await listReps(organizationId)
      return { added, updated, deactivated, reps: reps.map(presentRep) }
    })

    app.get('/settings', async (request, reply) => {
      const [rule] = await listActivePolicies(request.tenantContext.organizationId, 'routing')
      if (!rule) return err(request, reply, 404, 'ROUTING_POLICY_MISSING', 'This workspace has no lead assignment settings yet.')
      return { version: rule.version, maxOpenLeadsPerRep: rule.actions?.max_open_leads_per_rep ?? null }
    })

    app.put('/settings', {
      schema: {
        body: {
          type: 'object', required: ['maxOpenLeadsPerRep', 'version'], additionalProperties: false,
          properties: { maxOpenLeadsPerRep: { type: 'integer', minimum: 1, maximum: MAX_OPEN_LEADS_LIMIT }, version: { type: 'integer', minimum: 1 } },
        },
      },
    }, async (request, reply) => {
      const { organizationId } = request.tenantContext
      const { maxOpenLeadsPerRep, version } = request.body as { maxOpenLeadsPerRep: number; version: number }
      const [rule] = await listActivePolicies(organizationId, 'routing')
      if (!rule) return err(request, reply, 404, 'ROUTING_POLICY_MISSING', 'This workspace has no lead assignment settings yet.')
      if (rule.version !== version) return conflict(request, reply)
      const saved = await updatePolicy(organizationId, 'routing', rule.id, rule.version, { actions: { ...(rule.actions ?? {}), max_open_leads_per_rep: maxOpenLeadsPerRep } })
      if (!saved) return conflict(request, reply)
      return { version: saved.version, maxOpenLeadsPerRep }
    })

    app.patch('/:id', {
      schema: {
        params: uuidParam,
        body: { type: 'object', required: ['available'], additionalProperties: false, properties: { available: { type: 'boolean' } } },
      },
    }, async (request, reply) => {
      const { organizationId } = request.tenantContext
      const { id } = request.params as { id: string }
      const { available } = request.body as { available: boolean }
      const rep = (await listReps(organizationId)).find(r => r.id === id)
      if (!rep) return err(request, reply, 404, 'REP_NOT_FOUND', 'This rep was not found in your workspace.')
      const saved = await updateRepMetadata(organizationId, id, { ...rep.metadata, available })
      if (!saved) return err(request, reply, 404, 'REP_NOT_FOUND', 'This rep was not found in your workspace.')
      return presentRep(saved)
    })
  }
}

function conflict(request: FastifyRequest, reply: FastifyReply) {
  return err(request, reply, 409, 'POLICY_VERSION_CONFLICT', 'Someone else changed this. Refresh to see the latest.')
}

// ── Territories ───────────────────────────────────────────────────────────────

const territoryBody = {
  type: 'object',
  required: ['name', 'countries', 'repIds'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    countries: { type: ['array', 'null'], maxItems: 250, items: { type: 'string', pattern: '^[A-Za-z]{2}$' } },
    repIds: { type: ['array', 'null'], maxItems: 500, items: { type: 'string', format: 'uuid' } },
    priority: { type: 'integer', minimum: 1, maximum: 100000 },
  },
}

type TerritoryBody = { name: string; countries: string[] | null; repIds: string[] | null; priority?: number }

function presentTerritory(row: PolicyRowLite, reps: RepRow[]) {
  const { countries, ownerIds } = readTerritory(row)
  const repIds = ownerIds === null ? null : reps.filter(r => ownerIds.includes(r.external_id)).map(r => r.id)
  const missingReps = ownerIds === null ? 0 : ownerIds.filter(o => !reps.some(r => r.external_id === o)).length
  return { id: row.id, name: row.name, countries, repIds, missingReps, priority: row.priority }
}

/** Validates the body against this org's reps and other territories; returns the stored row or an error. */
function buildTerritory(body: TerritoryBody, reps: RepRow[], others: PolicyRowLite[], priority: number):
  { ok: true; row: ReturnType<typeof territoryRow> } | { ok: false; code: string; message: string } {
  const name = body.name.trim()
  let queue: string
  try { queue = territoryQueueName(name) } catch { return { ok: false, code: 'TERRITORY_NAME_INVALID', message: 'Give the territory a name with letters or numbers.' } }
  if (others.some(o => territoryQueueName(o.name) === queue)) {
    return { ok: false, code: 'TERRITORY_NAME_TAKEN', message: `There is already a territory called "${name}".` }
  }
  if (body.countries !== null && body.countries.length === 0) {
    return { ok: false, code: 'TERRITORY_COUNTRIES_EMPTY', message: 'Add at least one country, or choose "Everywhere".' }
  }
  let ownerIds: string[] | null = null
  if (body.repIds !== null) {
    if (body.repIds.length === 0) return { ok: false, code: 'TERRITORY_REPS_EMPTY', message: 'Pick at least one rep, or choose "All reps".' }
    const picked = body.repIds.map(id => reps.find(r => r.id === id))
    if (picked.some(r => !r)) return { ok: false, code: 'REP_NOT_FOUND', message: 'One of the selected reps is not in this workspace.' }
    ownerIds = [...new Set(picked.map(r => r!.external_id))]
  }
  return { ok: true, row: territoryRow({ name, countries: body.countries, ownerIds, priority }) }
}

export async function territoryRoutes(app: FastifyInstance) {
  app.get('/', async request => {
    const { organizationId } = request.tenantContext
    const [rows, reps] = await Promise.all([listActivePolicies(organizationId, 'territory'), listReps(organizationId)])
    return { territories: rows.map(r => presentTerritory(r, reps)) }
  })

  app.post('/', { schema: { body: territoryBody } }, async (request, reply) => {
    const { organizationId } = request.tenantContext
    const body = request.body as TerritoryBody
    const [rows, reps] = await Promise.all([listActivePolicies(organizationId, 'territory'), listReps(organizationId)])
    const priority = body.priority ?? (rows.reduce((m, r) => Math.max(m, r.priority), 0) + 10)
    const built = buildTerritory(body, reps, rows, priority)
    if (!built.ok) return err(request, reply, 400, built.code, built.message)
    const saved = await insertPolicy(organizationId, 'territory', {
      ...built.row, description: `Leads from ${body.countries === null ? 'anywhere' : body.countries.join(', ')} go to ${body.repIds === null ? 'all reps' : `${body.repIds.length} rep(s)`}.`,
    })
    return reply.status(201).send(presentTerritory(saved, reps))
  })

  app.put('/:id', { schema: { params: uuidParam, body: territoryBody } }, async (request, reply) => {
    const { organizationId } = request.tenantContext
    const { id } = request.params as { id: string }
    const body = request.body as TerritoryBody
    const [rows, reps] = await Promise.all([listActivePolicies(organizationId, 'territory'), listReps(organizationId)])
    const current = rows.find(r => r.id === id)
    if (!current) return err(request, reply, 404, 'TERRITORY_NOT_FOUND', 'This territory was not found in your workspace.')
    const built = buildTerritory(body, reps, rows.filter(r => r.id !== id), body.priority ?? current.priority)
    if (!built.ok) return err(request, reply, 400, built.code, built.message)
    const saved = await updatePolicy(organizationId, 'territory', id, current.version, built.row)
    if (!saved) return conflict(request, reply)
    return presentTerritory(saved, reps)
  })

  app.delete('/:id', { schema: { params: uuidParam } }, async (request, reply) => {
    const { organizationId } = request.tenantContext
    const { id } = request.params as { id: string }
    const current = (await listActivePolicies(organizationId, 'territory')).find(r => r.id === id)
    if (!current) return err(request, reply, 404, 'TERRITORY_NOT_FOUND', 'This territory was not found in your workspace.')
    const saved = await updatePolicy(organizationId, 'territory', id, current.version, { is_active: false })
    if (!saved) return conflict(request, reply)
    return reply.status(204).send()
  })
}
