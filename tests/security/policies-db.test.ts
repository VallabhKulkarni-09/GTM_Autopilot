/**
 * policies-db.test.ts — PUT/GET /api/policies against a real database (no mocks).
 *
 * The response time saved on the Connections page must land in policy_rules.actions.sla_minutes
 * (the field the inbound worker reads), bump the version, and never touch another workspace.
 *
 * Needs a throwaway database: eval "$(scripts/ci/test-db.sh)". Skips locally without one;
 * in CI (CI=true) a missing database fails the run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { getDb, _resetDbClient } from '../../src/db/client.js'
import { policyRoutes } from '../../src/routes/api/policies.js'

const ORG_A = process.env.DEFAULT_ORG_ID!
const ORG_B = '22222222-3333-4444-5555-666666666666'
const DB_READY = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY && ORG_A)
const RUN_SUITE = DB_READY || process.env.CI === 'true'
if (!RUN_SUITE) console.warn('[security] policies-db SKIPPED: run scripts/ci/test-db.sh to provide a test database')

let app: FastifyInstance
const ids = { slaA: randomUUID(), routingA: randomUUID(), slaB: randomUUID() }

async function cleanup() {
  const db = getDb()
  await db.from('policy_rules').delete().in('id', Object.values(ids))
  await db.from('organizations').delete().eq('id', ORG_B)
}

beforeAll(async () => {
  if (!RUN_SUITE) return
  if (!DB_READY) throw new Error('SUPABASE_URL, SUPABASE_SERVICE_KEY and DEFAULT_ORG_ID must be set (scripts/ci/test-db.sh)')
  await cleanup()
  const db = getDb()
  const { error: orgErr } = await db.from('organizations').insert({ id: ORG_B, name: 'Policies test org B', slug: `pol-b-${ORG_B.slice(0, 8)}`, is_active: true })
  if (orgErr) throw new Error(orgErr.message)
  const row = (id: string, org: string, rule_type: string, actions: Record<string, unknown>) =>
    ({ id, organization_id: org, rule_type, name: rule_type, description: 'test', conditions: {}, actions, priority: 999, is_active: true })
  const { error } = await db.from('policy_rules').insert([
    row(ids.slaA, ORG_A, 'sla', { sla_minutes: 15 }),
    row(ids.routingA, ORG_A, 'routing', { max_open_leads_per_rep: 25 }),
    row(ids.slaB, ORG_B, 'sla', { sla_minutes: 15 }),
  ])
  if (error) throw new Error(error.message)

  app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { req.tenantContext = { organizationId: ORG_A, userId: 'u', role: 'admin' } })
  await app.register(policyRoutes, { prefix: '/api/policies' })
  await app.ready()
})

afterAll(async () => {
  if (!RUN_SUITE) return
  await cleanup()
  _resetDbClient()
})

describe.skipIf(!RUN_SUITE)('PUT /api/policies/:id (real database)', () => {
  it('saves the response time where the worker reads it and bumps the version', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/policies/${ids.slaA}`, payload: { sla_minutes: 30 } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: ids.slaA, sla_minutes: 30, version: 2 })

    const { data } = await getDb().from('policy_rules').select('actions, version').eq('id', ids.slaA).single()
    expect(data).toEqual({ actions: { sla_minutes: 30 }, version: 2 })

    const list = (await app.inject({ method: 'GET', url: '/api/policies?rule_type=sla&limit=100' })).json()
    expect(list.find((p: any) => p.id === ids.slaA)?.sla_minutes).toBe(30)
  })

  it('response time on a non-SLA rule → 400, nothing changed', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/policies/${ids.routingA}`, payload: { sla_minutes: 5 } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('POLICY_FIELD_NOT_ALLOWED')
    const { data } = await getDb().from('policy_rules').select('actions, version').eq('id', ids.routingA).single()
    expect(data).toEqual({ actions: { max_open_leads_per_rep: 25 }, version: 1 })
  })

  it('invalid minutes → 400', async () => {
    for (const sla_minutes of [0, 1.5, 20000, 'soon']) {
      const res = await app.inject({ method: 'PUT', url: `/api/policies/${ids.slaA}`, payload: { sla_minutes } })
      expect(res.statusCode, String(sla_minutes)).toBe(400)
    }
  })

  it('another workspace’s rule → 404 and untouched', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/policies/${ids.slaB}`, payload: { sla_minutes: 1 } })
    expect(res.statusCode).toBe(404)
    const { data } = await getDb().from('policy_rules').select('actions, version').eq('id', ids.slaB).single()
    expect(data).toEqual({ actions: { sla_minutes: 15 }, version: 1 })
    const list = (await app.inject({ method: 'GET', url: '/api/policies?limit=100' })).json()
    expect(list.some((p: any) => p.id === ids.slaB)).toBe(false)
  })
})
