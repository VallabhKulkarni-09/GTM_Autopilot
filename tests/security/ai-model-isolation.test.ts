/**
 * ai-model-isolation.test.ts — the real /api/ai-model routes behind the real tenant middleware.
 * The workspace comes from membership (never the token claim or body); members cannot write.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'

const SECRET = 'test-secret-minimum-32-characters-long!!'
const SUPABASE_URL = 'https://example-project.supabase.co'
process.env.SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_JWT_SECRET = SECRET

const ROWS: Record<string, { provider: string; model: string; apiKey: string }> = {
  'org-tenant-a': { provider: 'openai', model: 'model-a', apiKey: 'key-of-a' },
  'org-tenant-b': { provider: 'ollama', model: 'model-b', apiKey: '' },
}
const repo = vi.hoisted(() => ({ describeAiModel: vi.fn(), loadAiModel: vi.fn(), saveAiModel: vi.fn(), deleteAiModel: vi.fn() }))
vi.mock('../../src/repositories/ai-model.repository.js', () => repo)
const evalRepo = vi.hoisted(() => ({ createEvaluation: vi.fn(async (org: string) => ({ id: `run-${org}`, status: 'running', results: null })), getLatestEvaluation: vi.fn(async (org: string) => (org === 'org-tenant-a' ? { id: 'run-a', status: 'completed', results: [], provider: 'openai', model: 'model-a' } : null)), setQualificationAgent: vi.fn(), setRoutingAgent: vi.fn(), getEvaluation: vi.fn() }))
vi.mock('../../src/repositories/ai-model-evaluation.repository.js', () => evalRepo)
const enqueueEvaluation = vi.fn(async () => {})

const { createTenantContextMiddleware, requireAdmin } = await import('../../src/middleware/tenant-context.js')
const { createAiModelRoutes } = await import('../../src/routes/api/ai-model.js')

const token = (sub: string) => new SignJWT({ email: `${sub}@example.com`, organization_id: 'org-tenant-a' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuer(`${SUPABASE_URL}/auth/v1`)
  .setAudience('authenticated').setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(SECRET))

const makeClient = vi.fn((cfg: { provider: string; model: string }) => ({
  provider: cfg.provider, model: cfg.model,
  chat: async () => ({ text: '{"ok":true}', model: cfg.model, latencyMs: 1 }),
  listModels: async () => [], modelDigest: async () => null,
}))

let app: FastifyInstance
let tokenB: string
let tokenMember: string

beforeAll(async () => {
  tokenB = await token('user-b')
  tokenMember = await token('member-b')
  repo.describeAiModel.mockImplementation(async (org: string) => ROWS[org]
    ? { provider: ROWS[org].provider, base_url: null, model: ROWS[org].model, has_api_key: !!ROWS[org].apiKey, data_consent_at: null, data_consent_by: null, last_test_ok: null, last_test_at: null, updated_at: 'x' }
    : null)
  repo.loadAiModel.mockImplementation(async (org: string) => ROWS[org] ? { provider: ROWS[org].provider, apiKey: ROWS[org].apiKey || null } : null)
  const middleware = createTenantContextMiddleware({
    getMemberships: async uid => uid === 'user-b' ? [{ organization_id: 'org-tenant-b', role: 'admin', created_at: '2026-01-01' }]
      : uid === 'member-b' ? [{ organization_id: 'org-tenant-b', role: 'member', created_at: '2026-01-01' }] : [],
  })
  app = Fastify({ logger: false })
  app.addHook('onRequest', async (req, reply) => {
    await middleware(req, reply)
    if (!reply.sent && req.method !== 'GET') await requireAdmin(req, reply)
  })
  await app.register(createAiModelRoutes({ makeClient: makeClient as never, resolver: async () => ['172.17.0.1'], enqueueEvaluation }), { prefix: '/api/ai-model' })
  await app.ready()
})

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

describe('AI model cross-tenant isolation', () => {
  it('B reads only its own connection (token org claim ignored)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ai-model', headers: auth(tokenB) })
    expect(res.json().model).toBe('model-b')
    expect(res.body).not.toContain('model-a')
    expect(repo.describeAiModel).toHaveBeenLastCalledWith('org-tenant-b')
  })

  it("B can never use A's saved key, even when choosing A's provider", async () => {
    makeClient.mockClear()
    const res = await app.inject({ method: 'POST', url: '/api/ai-model/test', headers: auth(tokenB), payload: { provider: 'openai', model: 'gpt-x' } })
    expect(res.statusCode).toBe(400)
    expect(makeClient).not.toHaveBeenCalled()
    expect(repo.loadAiModel).toHaveBeenLastCalledWith('org-tenant-b')
  })

  it("B's save and delete only touch B", async () => {
    await app.inject({ method: 'PUT', url: '/api/ai-model', headers: auth(tokenB), payload: { provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'm' } })
    expect(repo.saveAiModel.mock.calls.at(-1)?.[0]).toBe('org-tenant-b')
    await app.inject({ method: 'DELETE', url: '/api/ai-model', headers: auth(tokenB) })
    expect(repo.deleteAiModel).toHaveBeenLastCalledWith('org-tenant-b')
  })

  it('members can read but not test, save or delete', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/ai-model', headers: auth(tokenMember) })).statusCode).toBe(200)
    for (const [method, url] of [['POST', '/api/ai-model/test'], ['POST', '/api/ai-model/models'], ['PUT', '/api/ai-model'], ['DELETE', '/api/ai-model']] as const) {
      const res = await app.inject({ method, url, headers: auth(tokenMember), payload: method === 'DELETE' ? undefined : { provider: 'ollama', baseUrl: 'http://h', model: 'm' } })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
  })

  it("B's test-lead runs and agent switch are B's only; A's run is invisible to B", async () => {
    const latest = await app.inject({ method: 'GET', url: '/api/ai-model/evaluations/latest', headers: auth(tokenB) })
    expect(latest.json().evaluation).toBeNull()
    expect(latest.body).not.toContain('run-a')
    await app.inject({ method: 'POST', url: '/api/ai-model/evaluations', headers: auth(tokenB) })
    expect(evalRepo.createEvaluation.mock.calls.at(-1)?.[0]).toBe('org-tenant-b')
    expect(enqueueEvaluation).toHaveBeenLastCalledWith('org-tenant-b', 'run-org-tenant-b')
    const on = await app.inject({ method: 'PUT', url: '/api/ai-model/agents', headers: auth(tokenB), payload: { qualification: true } })
    expect(on.statusCode).toBe(409)   // A's completed run does not unlock B
    expect(evalRepo.setQualificationAgent).not.toHaveBeenCalled()
    for (const [method, url] of [['POST', '/api/ai-model/evaluations'], ['PUT', '/api/ai-model/agents']] as const) {
      const res = await app.inject({ method, url, headers: auth(tokenMember), payload: method === 'PUT' ? { qualification: true } : undefined })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
  })

  it('no token → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/ai-model' })).statusCode).toBe(401)
  })
})
