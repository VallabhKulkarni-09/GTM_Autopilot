/**
 * setup-isolation.test.ts — the setup checklist and test-lead routes behind the real tenant
 * middleware. The workspace comes only from org_members: a token's organization claim, a body
 * field or a header for a workspace the user is not in can never redirect a read or a write.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'

const SECRET = 'test-secret-minimum-32-characters-long!!'
const SUPABASE_URL = 'https://example-project.supabase.co'
process.env.SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_JWT_SECRET = SECRET

const testLeads = vi.hoisted(() => ({ listTestLeads: vi.fn(), listTestPlays: vi.fn(), removeTestLeads: vi.fn(), countTestLeads: vi.fn() }))
const setupRepo = vi.hoisted(() => ({ getSetupCompletedAt: vi.fn(), markSetupCompleted: vi.fn() }))
const creds = vi.hoisted(() => ({ describeConnector: vi.fn() }))
vi.mock('../../src/repositories/test-lead.repository.js', () => testLeads)
vi.mock('../../src/repositories/setup.repository.js', () => setupRepo)
vi.mock('../../src/repositories/connector-credentials.repository.js', () => creds)
vi.mock('../../src/repositories/reps.repository.js', () => ({ listReps: vi.fn(async () => []), listActivePolicies: vi.fn(async () => []) }))
vi.mock('../../src/repositories/icp-policy.repository.js', () => ({ getActiveIcpPolicy: vi.fn(async () => null) }))

const { createTenantContextMiddleware, requireAdmin } = await import('../../src/middleware/tenant-context.js')
const { createTestLeadRoutes } = await import('../../src/routes/api/test-lead.js')
const { setupRoutes } = await import('../../src/routes/api/setup.js')

// user-b is admin of org-tenant-b only; the token claims org-tenant-a
const token = (sub: string) => new SignJWT({ email: `${sub}@example.com`, organization_id: 'org-tenant-a' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuer(`${SUPABASE_URL}/auth/v1`)
  .setAudience('authenticated').setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(SECRET))

let app: FastifyInstance
let tokenB: string
const enqueue = vi.fn()

beforeAll(async () => {
  tokenB = await token('user-b')
  const middleware = createTenantContextMiddleware({
    getMemberships: async uid => (uid === 'user-b' ? [{ organization_id: 'org-tenant-b', role: 'admin', created_at: '2026-01-01' }] : []),
  })
  app = Fastify({ logger: false })
  app.addHook('onRequest', async (req, reply) => {
    await middleware(req, reply)
    if (!reply.sent && req.method !== 'GET') await requireAdmin(req, reply)
  })
  await app.register(createTestLeadRoutes({ enqueue }), { prefix: '/api/test-lead' })
  await app.register(setupRoutes, { prefix: '/api/setup' })
  await app.ready()
})

beforeEach(() => {
  for (const m of [...Object.values(testLeads), ...Object.values(setupRepo), ...Object.values(creds), enqueue]) m.mockReset()
  testLeads.listTestLeads.mockResolvedValue([])
  testLeads.listTestPlays.mockResolvedValue([])
  testLeads.countTestLeads.mockResolvedValue(0)
  testLeads.removeTestLeads.mockResolvedValue(0)
  setupRepo.getSetupCompletedAt.mockResolvedValue(null)
  creds.describeConnector.mockResolvedValue({ configured: false, public: {}, healthStatus: null, lastCheckedAt: null })
})

const auth = () => ({ Authorization: `Bearer ${tokenB}` })

describe('Setup + test lead isolation', () => {
  it('a test lead is always queued for the caller’s own workspace (token claim ignored)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/test-lead', headers: auth(), payload: { email: 'a@b.co' } })
    expect(res.statusCode).toBe(202)
    expect(enqueue.mock.calls[0][0].organizationId).toBe('org-tenant-b')
    expect(enqueue.mock.calls[0][0].idempotencyKey).toMatch(/^test-lead:org-tenant-b:/)
  })

  it('x-workspace-id for a workspace the user is not in → 403 NO_WORKSPACE, nothing queued', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/test-lead', headers: { ...auth(), 'x-workspace-id': 'org-tenant-a' }, payload: { email: 'a@b.co' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('NO_WORKSPACE')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('listing and removing test leads only touch the caller’s workspace', async () => {
    await app.inject({ method: 'GET', url: '/api/test-lead', headers: auth() })
    await app.inject({ method: 'DELETE', url: '/api/test-lead', headers: auth() })
    expect(testLeads.listTestLeads).toHaveBeenCalledWith('org-tenant-b', 10)
    expect(testLeads.removeTestLeads).toHaveBeenCalledWith('org-tenant-b', expect.any(String))
  })

  it('the setup checklist and finish only read/write the caller’s workspace', async () => {
    await app.inject({ method: 'GET', url: '/api/setup', headers: auth() })
    await app.inject({ method: 'POST', url: '/api/setup/complete', headers: auth() })
    expect(creds.describeConnector.mock.calls.every(c => c[0] === 'org-tenant-b')).toBe(true)
    expect(setupRepo.getSetupCompletedAt).toHaveBeenCalledWith('org-tenant-b')
    expect(testLeads.countTestLeads.mock.calls.every(c => c[0] === 'org-tenant-b')).toBe(true)
    expect(setupRepo.markSetupCompleted).not.toHaveBeenCalled()   // steps not done → 409
  })

  it('no token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/setup' })
    expect(res.statusCode).toBe(401)
  })
})
