/**
 * outreach-isolation.test.ts — the real /api/outreach routes behind the real tenant
 * middleware. Each org only ever sees and edits its own outreach policy and its own
 * Apollo sequences; the org comes from membership, never from the request.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'

const SECRET = 'test-secret-minimum-32-characters-long!!'
const SUPABASE_URL = 'https://example-project.supabase.co'
process.env.SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_JWT_SECRET = SECRET

const cfg = (seq: string) => ({
  email_account: { id: `acct-${seq}`, email: `${seq}@example.com` },
  tiers: { tier_1: { mode: 'sequence', sequence_id: seq, sequence_name: seq }, tier_2: { mode: 'manual' } },
})
const POLICIES: Record<string, { id: string; name: string; version: number; priority: number; conditions: object; actions: object }> = {
  'org-tenant-a': { id: 'pol-a', name: 'Outreach', version: 1, priority: 50, conditions: {}, actions: cfg('seq-a') },
  'org-tenant-b': { id: 'pol-b', name: 'Outreach', version: 1, priority: 50, conditions: {}, actions: cfg('seq-b') },
}

const repo = vi.hoisted(() => ({
  listReps: vi.fn(), insertRep: vi.fn(), updateRepMetadata: vi.fn(),
  listActivePolicies: vi.fn(), insertPolicy: vi.fn(), updatePolicy: vi.fn(),
}))
vi.mock('../../src/repositories/reps.repository.js', () => repo)
vi.mock('../../src/connectors/factory.js', () => ({ getConnectors: vi.fn() }))

const { createTenantContextMiddleware, requireAdmin } = await import('../../src/middleware/tenant-context.js')
const { createOutreachRoutes } = await import('../../src/routes/api/outreach.js')

const token = (sub: string) => new SignJWT({ email: `${sub}@example.com`, organization_id: 'org-tenant-a' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuer(`${SUPABASE_URL}/auth/v1`)
  .setAudience('authenticated').setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(SECRET))

let app: FastifyInstance
let tokenB: string
const loadApolloOptions = vi.fn(async (org: string) => ({ sequences: [{ id: `only-${org}`, name: org, active: true }], emailAccounts: [] }))

beforeAll(async () => {
  tokenB = await token('user-b')
  repo.listActivePolicies.mockImplementation(async (org: string) => (POLICIES[org] ? [POLICIES[org]] : []))
  repo.updatePolicy.mockImplementation(async (org: string, _t: string, id: string, v: number, ch: { actions: object }) =>
    POLICIES[org]?.id === id ? { ...POLICIES[org], version: v + 1, actions: ch.actions } : null)

  const middleware = createTenantContextMiddleware({
    getMemberships: async uid => (uid === 'user-b' ? [{ organization_id: 'org-tenant-b', role: 'admin', created_at: '2026-01-01' }] : []),
  })
  app = Fastify({ logger: false })
  app.addHook('onRequest', async (req, reply) => {
    await middleware(req, reply)
    if (!reply.sent && req.method !== 'GET') await requireAdmin(req, reply)
  })
  await app.register(createOutreachRoutes({ loadApolloOptions }), { prefix: '/api/outreach' })
  await app.ready()
})

describe('Outreach cross-tenant isolation', () => {
  it('B reads only its own outreach policy (token org claim ignored)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/outreach', headers: { Authorization: `Bearer ${tokenB}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe('pol-b')
    expect(res.body).not.toContain('seq-a')
  })

  it("B's save only touches B's row", async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/outreach', headers: { Authorization: `Bearer ${tokenB}` },
      payload: { config: cfg('seq-new'), version: 1, organizationId: 'org-tenant-a' },
    })
    expect(res.statusCode).toBe(200)
    expect(repo.updatePolicy).toHaveBeenCalledTimes(1)
    expect(repo.updatePolicy.mock.calls[0].slice(0, 3)).toEqual(['org-tenant-b', 'outreach', 'pol-b'])
  })

  it('B lists only its own Apollo sequences', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/outreach/options', headers: { Authorization: `Bearer ${tokenB}` } })
    expect(res.json().sequences).toEqual([{ id: 'only-org-tenant-b', name: 'org-tenant-b', active: true }])
    expect(loadApolloOptions).toHaveBeenCalledWith('org-tenant-b')
  })

  it('no token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/outreach' })
    expect(res.statusCode).toBe(401)
  })
})
