import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const repo = vi.hoisted(() => ({ listTestLeads: vi.fn(), listTestPlays: vi.fn(), removeTestLeads: vi.fn(), countTestLeads: vi.fn() }))
vi.mock('../../../src/repositories/test-lead.repository.js', () => repo)

const { createTestLeadRoutes } = await import('../../../src/routes/api/test-lead.js')

const enqueue = vi.fn()

async function makeApp(role: 'admin' | 'member' = 'admin') {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { req.tenantContext = { organizationId: 'org-a', userId: 'user-1', role } })
  await app.register(createTestLeadRoutes({ enqueue }), { prefix: '/api/test-lead' })
  await app.ready()
  return app
}

beforeEach(() => {
  for (const m of Object.values(repo)) m.mockReset()
  enqueue.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/test-lead', () => {
  it('enqueues an inbound lead marked as a test, for the caller’s workspace only', async () => {
    const before = Date.now()
    const res = await (await makeApp()).inject({
      method: 'POST', url: '/api/test-lead',
      payload: { email: 'Jo@Acme.example', firstName: 'Jo', lastName: ' ', title: 'VP Sales' },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ status: 'queued', email: 'jo@acme.example' })

    const job = enqueue.mock.calls[0][0]
    expect(job).toMatchObject({
      organizationId: 'org-a', isTest: true, requestedBy: 'user-1',
      payload: { subscriptionType: 'test_lead', properties: { email: 'jo@acme.example', firstname: 'Jo', lastname: null, jobtitle: 'VP Sales' } },
    })
    // No HubSpot ids → the worker uses the payload instead of fetching a contact
    expect(job.payload).not.toHaveProperty('objectId')
    expect(job.payload).not.toHaveProperty('portalId')
    // SLA clock starts when the admin pressed Send
    expect(job.payload.occurredAt).toBeGreaterThanOrEqual(before)
    expect(job.receivedAt).toBe(new Date(job.payload.occurredAt).toISOString())
    expect(job.idempotencyKey).toBe(`test-lead:org-a:${job.payload.eventId}`)
  })

  it('a workspace id in the body is ignored (stripped by the schema)', async () => {
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/test-lead', payload: { email: 'a@b.co', organizationId: 'org-b' } })
    expect(res.statusCode).toBe(202)
    expect(enqueue.mock.calls[0][0].organizationId).toBe('org-a')
    expect(JSON.stringify(enqueue.mock.calls[0][0])).not.toContain('org-b')
  })

  it('each send is a new lead (distinct keys)', async () => {
    const app = await makeApp()
    await app.inject({ method: 'POST', url: '/api/test-lead', payload: { email: 'a@b.co' } })
    await app.inject({ method: 'POST', url: '/api/test-lead', payload: { email: 'a@b.co' } })
    expect(enqueue.mock.calls[0][0].idempotencyKey).not.toBe(enqueue.mock.calls[1][0].idempotencyKey)
  })

  it('needs a valid email', async () => {
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/test-lead', payload: { email: 'not-an-email' } })
    expect(res.statusCode).toBe(400)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('members cannot send', async () => {
    const res = await (await makeApp('member')).inject({ method: 'POST', url: '/api/test-lead', payload: { email: 'a@b.co' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('ADMIN_REQUIRED')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('queue down → 503 with a plain explanation', async () => {
    enqueue.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/test-lead', payload: { email: 'a@b.co' } })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ error: 'QUEUE_UNAVAILABLE', message: expect.stringContaining('Redis') })
    expect(res.body).not.toContain('ECONNREFUSED')
  })
})

describe('GET /api/test-lead', () => {
  it('lists test leads with their latest play', async () => {
    repo.listTestLeads.mockResolvedValue([
      { id: 'l1', email: 'jo@acme.example', first_name: 'Jo', last_name: 'Rivera', stage: 'routing', icp_tier: 'tier_1', form_submitted_at: '2026-10-26T10:00:00Z' },
      { id: 'l2', email: 'x@y.example', first_name: null, last_name: null, stage: 'new', icp_tier: null, form_submitted_at: '2026-10-26T09:00:00Z' },
    ])
    repo.listTestPlays.mockResolvedValue([
      { lead_id: 'l1', status: 'running', assigned_owner_name: 'Alice Ng', created_at: '2026-10-26T10:00:05Z' },
      { lead_id: 'l1', status: 'failed', assigned_owner_name: null, created_at: '2026-10-26T09:59:00Z' },
    ])
    const res = await (await makeApp('member')).inject({ method: 'GET', url: '/api/test-lead' })
    expect(res.statusCode).toBe(200)
    expect(repo.listTestLeads).toHaveBeenCalledWith('org-a', 10)
    expect(repo.listTestPlays).toHaveBeenCalledWith('org-a', ['l1', 'l2'])
    expect(res.json().leads).toEqual([
      { id: 'l1', name: 'Jo Rivera', email: 'jo@acme.example', stage: 'routing', fit: 'tier_1', submittedAt: '2026-10-26T10:00:00Z', playStatus: 'running', owner: 'Alice Ng' },
      { id: 'l2', name: 'x@y.example', email: 'x@y.example', stage: 'new', fit: null, submittedAt: '2026-10-26T09:00:00Z', playStatus: null, owner: null },
    ])
  })
})

describe('DELETE /api/test-lead', () => {
  it('removes this workspace’s test leads', async () => {
    repo.removeTestLeads.mockResolvedValue(2)
    const res = await (await makeApp()).inject({ method: 'DELETE', url: '/api/test-lead' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ removed: 2 })
    expect(repo.removeTestLeads).toHaveBeenCalledWith('org-a', expect.any(String))
  })

  it('members cannot remove', async () => {
    const res = await (await makeApp('member')).inject({ method: 'DELETE', url: '/api/test-lead' })
    expect(res.statusCode).toBe(403)
    expect(repo.removeTestLeads).not.toHaveBeenCalled()
  })
})
