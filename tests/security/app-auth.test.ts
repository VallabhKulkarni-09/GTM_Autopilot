/**
 * app-auth.test.ts — the real buildApp() wiring: every /api route is authenticated,
 * admin-only prefixes reject members, and the legacy static dashboard JWT is refused.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { SignJWT } from 'jose'
import { createHmac } from 'crypto'

const SECRET = 'test-secret-minimum-32-characters-long!!'
const SUPABASE_URL = 'https://example-project.supabase.co'
process.env.SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_JWT_SECRET = SECRET

vi.mock('../../src/repositories/org-members.repository.js', () => ({
  getMembershipsForUser: vi.fn(async (uid: string) =>
    uid === 'member-user' ? [{ organization_id: 'org-a', role: 'member', created_at: '2026-01-01' }] : []),
  addMember: vi.fn(),
}))

const { buildApp, ADMIN_WRITE_PREFIXES } = await import('../../src/app.js')

const sign = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
  .setIssuer(`${SUPABASE_URL}/auth/v1`).setAudience('authenticated').setExpirationTime('1h')
  .sign(new TextEncoder().encode(SECRET))

let app: ReturnType<typeof buildApp>
beforeAll(async () => { app = buildApp(); await app.ready() })

describe('buildApp auth wiring', () => {
  it('health stays public', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
  })

  it('legacy organization_id-claim dashboard JWT is rejected', async () => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const b = Buffer.from(JSON.stringify({ organization_id: 'org-a', exp: 9999999999 })).toString('base64url')
    const s = createHmac('sha256', 'legacy-secret').update(`${h}.${b}`).digest('base64url')
    const res = await app.inject({ method: 'GET', url: '/api/leads', headers: { Authorization: `Bearer ${h}.${b}.${s}` } })
    expect(res.statusCode).toBe(401)
  })

  it.each(ADMIN_WRITE_PREFIXES.map(p => [p]))('member cannot write under %s', async (prefix) => {
    const id = '00000000-0000-0000-0000-000000000000'
    const [method, url] = ({
      '/api/policies': ['PUT', `/api/policies/${id}`],
      '/api/connectors': ['POST', '/api/connectors/apollo/save'],
      '/api/team': ['POST', '/api/team'],
      '/api/reps': ['POST', '/api/reps/import'],
      '/api/territories': ['POST', '/api/territories'],
      '/api/outreach': ['PUT', '/api/outreach'],
      '/api/plays': ['POST', `/api/plays/${id}/approve`],
      '/api/test-lead': ['DELETE', '/api/test-lead'],
      '/api/ai-model': ['PUT', '/api/ai-model'],
      '/api/setup': ['POST', '/api/setup/complete'],
    } as Record<string, [string, string]>)[prefix]
    const res = await app.inject({ method: method as 'PUT' | 'POST' | 'DELETE', url, headers: { Authorization: `Bearer ${await sign('member-user')}` }, payload: {} })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('ADMIN_REQUIRED')
  })

  it('user without a workspace gets an empty /api/me', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { Authorization: `Bearer ${await sign('new-user')}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ user: { id: 'new-user' }, workspace: null, role: null })
  })
})
