/**
 * cross-tenant.test.ts — auth + cross-tenant isolation.
 *
 * Tokens are real HS256 Supabase-shaped JWTs (iss/aud/sub/exp) signed with a test secret.
 * The organization comes ONLY from the membership lookup (mocked here at the repository
 * boundary). Cross-tenant access must return 404, never 403.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'
import { createTenantContextMiddleware, requireAdmin } from '../../src/middleware/tenant-context.js'
import type { MembershipRow } from '../../src/repositories/org-members.repository.js'

const SECRET = 'test-secret-minimum-32-characters-long!!'
const SUPABASE_URL = 'https://example-project.supabase.co'
process.env.SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_JWT_SECRET = SECRET

const MEMBERSHIPS: Record<string, MembershipRow[]> = {
  'user-a':        [{ organization_id: 'org-tenant-a', role: 'admin',  created_at: '2026-01-01' }],
  'user-b':        [{ organization_id: 'org-tenant-b', role: 'admin',  created_at: '2026-01-01' }],
  'user-a-member': [{ organization_id: 'org-tenant-a', role: 'member', created_at: '2026-01-01' }],
  'user-none':     [],
}

async function token(sub: string, opts: { claims?: Record<string, unknown>; secret?: string; iss?: string; exp?: string | number } = {}) {
  return new SignJWT({ email: `${sub}@example.com`, ...opts.claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(opts.iss ?? `${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(new TextEncoder().encode(opts.secret ?? SECRET))
}

let app: FastifyInstance
let tokenA: string, tokenB: string, tokenMember: string, tokenNone: string

beforeAll(async () => {
  tokenA = await token('user-a')
  tokenB = await token('user-b')
  tokenMember = await token('user-a-member')
  tokenNone = await token('user-none')

  const middleware = createTenantContextMiddleware({ getMemberships: async uid => MEMBERSHIPS[uid] ?? [] })
  app = Fastify({ logger: false })
  app.addHook('preHandler', async (req, reply) => {
    await middleware(req, reply)
    if (!reply.sent && req.method !== 'GET' && req.url.startsWith('/api/policies')) await requireAdmin(req, reply)
  })

  const owned = (id: string, org: string) =>
    (id.startsWith('org-a') && org === 'org-tenant-a') || (id.startsWith('org-b') && org === 'org-tenant-b')

  app.get('/api/leads/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!owned(id, req.tenantContext.organizationId)) return reply.status(404).send({ error: 'NOT_FOUND' })
    return reply.send({ id, organizationId: req.tenantContext.organizationId })
  })
  app.get('/api/leads/:id/timeline', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!owned(id, req.tenantContext.organizationId)) return reply.status(404).send({ error: 'NOT_FOUND' })
    return reply.send([])
  })
  app.get('/api/plays/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!owned(id, req.tenantContext.organizationId)) return reply.status(404).send({ error: 'NOT_FOUND' })
    return reply.send({ id })
  })
  app.put('/api/policies/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!owned(id, req.tenantContext.organizationId)) return reply.status(404).send({ error: 'NOT_FOUND' })
    return reply.send({ id })
  })
  app.get('/api/connectors', async (req, reply) => reply.send({ organizationId: req.tenantContext.organizationId }))
  app.post('/api/workspaces', { config: { allowNoWorkspace: true } }, async (req, reply) =>
    reply.send({ hasWorkspace: Boolean(req.tenantContext), userId: req.authUser.userId }))

  await app.ready()
})

const get = (url: string, t?: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...headers } })

describe('Auth enforcement', () => {
  it('no Authorization header → 401 MISSING_TOKEN', async () => {
    const res = await get('/api/leads/org-a-lead')
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('MISSING_TOKEN')
  })

  it('garbage token → 401 INVALID_TOKEN', async () => {
    expect((await get('/api/leads/org-a-lead', 'eyJhbGciOiJIUzI1NiJ9.invalid.payload')).json().error).toBe('INVALID_TOKEN')
  })

  it('wrong signing secret → 401', async () => {
    const bad = await token('user-a', { secret: 'another-secret-another-secret-123456' })
    expect((await get('/api/leads/org-a-lead', bad)).statusCode).toBe(401)
  })

  it('expired token → 401', async () => {
    const expired = await token('user-a', { exp: Math.floor(Date.now() / 1000) - 60 })
    expect((await get('/api/leads/org-a-lead', expired)).statusCode).toBe(401)
  })

  it('token from another Supabase project (wrong iss) → 401', async () => {
    const foreign = await token('user-a', { iss: 'https://other.supabase.co/auth/v1' })
    expect((await get('/api/leads/org-a-lead', foreign)).statusCode).toBe(401)
  })

  it('alg "none" token → 401', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({ sub: 'user-a', aud: 'authenticated', iss: `${SUPABASE_URL}/auth/v1`, exp: 9999999999 })).toString('base64url')
    expect((await get('/api/leads/org-a-lead', `${header}.${body}.`)).statusCode).toBe(401)
  })

  it('signed-in user with no workspace → 403 NO_WORKSPACE on normal routes', async () => {
    const res = await get('/api/leads/org-a-lead', tokenNone)
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('NO_WORKSPACE')
  })

  it('signed-in user with no workspace may call allowNoWorkspace routes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { Authorization: `Bearer ${tokenNone}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hasWorkspace: false, userId: 'user-none' })
  })
})

describe('Organization comes only from membership', () => {
  it('an organization_id claim inside the token is ignored', async () => {
    const forged = await token('user-a', { claims: { organization_id: 'org-tenant-b', organizationId: 'org-tenant-b' } })
    const res = await get('/api/connectors', forged)
    expect(res.json().organizationId).toBe('org-tenant-a')
  })

  it('x-workspace-id for a workspace the user is NOT in → 403 NO_WORKSPACE', async () => {
    const res = await get('/api/leads/org-b-lead', tokenA, { 'x-workspace-id': 'org-tenant-b' })
    expect(res.statusCode).toBe(403)
  })
})

describe('Cross-tenant isolation — 404, not 403', () => {
  it('A cannot read B lead', async () => expect((await get('/api/leads/org-b-lead-1', tokenA)).statusCode).toBe(404))
  it('B cannot read A lead', async () => expect((await get('/api/leads/org-a-lead-1', tokenB)).statusCode).toBe(404))
  it('A cannot read B play', async () => expect((await get('/api/plays/org-b-play-1', tokenA)).statusCode).toBe(404))
  it('A cannot read B timeline', async () => expect((await get('/api/leads/org-b-lead-1/timeline', tokenA)).statusCode).toBe(404))
  it('A cannot modify B policy', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/policies/org-b-policy-1', headers: { Authorization: `Bearer ${tokenA}` }, payload: { name: 'x' } })
    expect(res.statusCode).toBe(404)
  })
  it('A reads its own lead', async () => {
    const res = await get('/api/leads/org-a-lead-1', tokenA)
    expect(res.statusCode).toBe(200)
    expect(res.json().organizationId).toBe('org-tenant-a')
  })
})

describe('Roles', () => {
  it('member can read', async () => expect((await get('/api/leads/org-a-lead-1', tokenMember)).statusCode).toBe(200))
  it('member cannot change policies → 403 ADMIN_REQUIRED', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/policies/org-a-policy-1', headers: { Authorization: `Bearer ${tokenMember}` }, payload: {} })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('ADMIN_REQUIRED')
  })
  it('admin can change own policies', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/policies/org-a-policy-1', headers: { Authorization: `Bearer ${tokenA}` }, payload: {} })
    expect(res.statusCode).toBe(200)
  })
})
