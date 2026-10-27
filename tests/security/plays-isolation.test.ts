/**
 * plays-isolation.test.ts — the real approve/reject/approvals/attention routes behind the
 * real tenant middleware. A play in another workspace is 404 (never 403), and a decision
 * can only ever be recorded against the caller's own org.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'

const SECRET = 'test-secret-minimum-32-characters-long!!'
const SUPABASE_URL = 'https://example-project.supabase.co'
process.env.SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_JWT_SECRET = SECRET

const PLAY_A = '11111111-1111-4111-8111-111111111111'
const PLAYS: Record<string, string> = { 'org-tenant-a': PLAY_A }

const review = vi.hoisted(() => ({
  getPlayForReview: vi.fn(), claimReviewDecision: vi.fn(), markPlayResumed: vi.fn(), markPlayEscalated: vi.fn(),
  listAwaitingReview: vi.fn(), listSlaBreachedUncontacted: vi.fn(), listEscalatedUncontacted: vi.fn(), getLeadBriefs: vi.fn(),
}))
vi.mock('../../src/repositories/play-review.repository.js', () => review)
vi.mock('../../src/repositories/reps.repository.js', () => ({ listReps: vi.fn(async () => []) }))
vi.mock('../../src/events/event-log.js', () => ({ writeEvent: vi.fn() }))
vi.mock('../../src/evidence/context-builder.js', () => ({ buildDecisionSnapshot: vi.fn(async () => ({})) }))

const { createTenantContextMiddleware, requireAdmin } = await import('../../src/middleware/tenant-context.js')
const { createPlayRoutes, createApprovalRoutes, createAttentionRoutes } = await import('../../src/routes/api/plays.js')

const token = (sub: string) => new SignJWT({ email: `${sub}@example.com`, organization_id: 'org-tenant-a' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuer(`${SUPABASE_URL}/auth/v1`)
  .setAudience('authenticated').setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(SECRET))

let app: FastifyInstance
let tokenB: string
const enqueueResume = vi.fn()

beforeAll(async () => {
  tokenB = await token('user-b')
  review.getPlayForReview.mockImplementation(async (org: string, id: string) =>
    PLAYS[org] === id ? { id, lead_id: 'l', status: 'paused', review_kind: 'routing', review_context: { reason_codes: [] }, review_decision: null } : null)
  review.listAwaitingReview.mockImplementation(async (org: string) => ({ rows: [], total: org === 'org-tenant-a' ? 1 : 0 }))
  review.listSlaBreachedUncontacted.mockResolvedValue({ rows: [], total: 0 })
  review.listEscalatedUncontacted.mockResolvedValue({ rows: [], total: 0 })
  review.getLeadBriefs.mockResolvedValue(new Map())

  const middleware = createTenantContextMiddleware({
    getMemberships: async uid => (uid === 'user-b' ? [{ organization_id: 'org-tenant-b', role: 'admin', created_at: '2026-01-01' }] : []),
  })
  app = Fastify({ logger: false })
  app.addHook('onRequest', async (req, reply) => {
    await middleware(req, reply)
    if (!reply.sent && req.method !== 'GET') await requireAdmin(req, reply)
  })
  await app.register(createPlayRoutes({ enqueueResume }), { prefix: '/api/plays' })
  await app.register(createApprovalRoutes(), { prefix: '/api/approvals' })
  await app.register(createAttentionRoutes(), { prefix: '/api/attention' })
  await app.ready()
})

const auth = () => ({ Authorization: `Bearer ${tokenB}` })

describe('Plays cross-tenant isolation', () => {
  it("B cannot approve or reject A's play → 404, nothing recorded", async () => {
    for (const action of ['approve', 'reject']) {
      const res = await app.inject({ method: 'POST', url: `/api/plays/${PLAY_A}/${action}`, headers: auth(), payload: {} })
      expect(res.statusCode).toBe(404)
    }
    expect(review.getPlayForReview).toHaveBeenCalledWith('org-tenant-b', PLAY_A)
    expect(review.claimReviewDecision).not.toHaveBeenCalled()
    expect(enqueueResume).not.toHaveBeenCalled()
  })

  it("B's approvals and attention only count B's plays", async () => {
    expect((await app.inject({ method: 'GET', url: '/api/approvals', headers: auth() })).json().total).toBe(0)
    expect((await app.inject({ method: 'GET', url: '/api/attention', headers: auth() })).json().awaitingReview.total).toBe(0)
    expect(review.listAwaitingReview.mock.calls.every(c => c[0] === 'org-tenant-b')).toBe(true)
  })

  it('no token → 401', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/plays/${PLAY_A}/approve` })).statusCode).toBe(401)
  })
})
