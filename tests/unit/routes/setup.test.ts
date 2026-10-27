import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const creds = vi.hoisted(() => ({ describeConnector: vi.fn() }))
const reps = vi.hoisted(() => ({ listReps: vi.fn(), listActivePolicies: vi.fn() }))
const icp = vi.hoisted(() => ({ getActiveIcpPolicy: vi.fn() }))
const tests = vi.hoisted(() => ({ countTestLeads: vi.fn() }))
const setup = vi.hoisted(() => ({ getSetupCompletedAt: vi.fn(), markSetupCompleted: vi.fn() }))
vi.mock('../../../src/repositories/connector-credentials.repository.js', () => creds)
vi.mock('../../../src/repositories/reps.repository.js', () => reps)
vi.mock('../../../src/repositories/icp-policy.repository.js', () => icp)
vi.mock('../../../src/repositories/test-lead.repository.js', () => tests)
vi.mock('../../../src/repositories/setup.repository.js', () => setup)

const { setupRoutes } = await import('../../../src/routes/api/setup.js')

async function makeApp(role: 'admin' | 'member' = 'admin') {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { req.tenantContext = { organizationId: 'org-a', userId: 'u', role } })
  await app.register(setupRoutes, { prefix: '/api/setup' })
  await app.ready()
  return app
}

const connected = { configured: true, public: {}, healthStatus: 'healthy', lastCheckedAt: null }
const notConnected = { configured: false, public: {}, healthStatus: null, lastCheckedAt: null }
const rep = (over = {}) => ({ id: 'r', external_id: '005', metadata: { name: 'A', email: 'a@x', title: null, available: true, sf_active: true, imported_at: '' , ...over } })

function allDone() {
  creds.describeConnector.mockResolvedValue(connected)
  reps.listReps.mockResolvedValue([rep(), rep({ available: false })])
  icp.getActiveIcpPolicy.mockResolvedValue({ id: 'icp', version: 2, conditions: {}, updated_at: '' })
  reps.listActivePolicies.mockResolvedValue([{ id: 'o', name: 'Outreach', version: 3, priority: 50, conditions: {}, actions: { email_account: null, tiers: { tier_1: { mode: 'manual' }, tier_2: { mode: 'manual' } } } }])
  tests.countTestLeads.mockResolvedValue(1)
}

beforeEach(() => {
  for (const m of [creds, reps, icp, tests, setup].flatMap(o => Object.values(o))) m.mockReset()
  setup.getSetupCompletedAt.mockResolvedValue(null)
  allDone()
})

const stepsOf = (body: any) => Object.fromEntries(body.steps.map((s: any) => [s.key, s]))

describe('GET /api/setup', () => {
  it('a fresh workspace: nothing done, cannot finish', async () => {
    creds.describeConnector.mockResolvedValue(notConnected)
    reps.listReps.mockResolvedValue([])
    icp.getActiveIcpPolicy.mockResolvedValue({ id: 'icp', version: 1, conditions: {}, updated_at: '' })
    reps.listActivePolicies.mockResolvedValue([{ id: 'o', name: 'Outreach', version: 1, priority: 50, conditions: {}, actions: { email_account: null, tiers: { tier_1: null, tier_2: null } } }])
    tests.countTestLeads.mockResolvedValue(0)

    const body = (await (await makeApp('member')).inject({ method: 'GET', url: '/api/setup' })).json()
    expect(body.canFinish).toBe(false)
    expect(body.completedAt).toBeNull()
    expect(body.steps.map((s: any) => s.key)).toEqual(['hubspot', 'salesforce', 'apollo', 'reps', 'ideal_customer', 'outreach', 'test_lead'])
    expect(body.steps.every((s: any) => s.done === false)).toBe(true)
    expect(stepsOf(body).outreach.facts).toEqual({ valid: true, tiersChosen: 0, tiers: 2 })
    // Every lookup is for the caller's workspace
    for (const m of [creds.describeConnector, reps.listReps, icp.getActiveIcpPolicy, reps.listActivePolicies, tests.countTestLeads]) {
      expect(m.mock.calls.every(c => c[0] === 'org-a')).toBe(true)
    }
  })

  it('required steps done → can finish; reps count only active + available', async () => {
    const body = (await (await makeApp()).inject({ method: 'GET', url: '/api/setup' })).json()
    expect(body.canFinish).toBe(true)
    expect(stepsOf(body).reps).toMatchObject({ required: true, done: true, facts: { reps: 2, takingLeads: 1 } })
    expect(stepsOf(body).ideal_customer.done).toBe(true)
    expect(stepsOf(body).outreach.done).toBe(true)
  })

  it('Apollo, ideal customer and outreach are recommended, not required', async () => {
    creds.describeConnector.mockImplementation(async (_o: string, name: string) => (name === 'apollo' ? notConnected : connected))
    icp.getActiveIcpPolicy.mockResolvedValue({ id: 'icp', version: 1, conditions: {}, updated_at: '' })
    reps.listActivePolicies.mockResolvedValue([])
    const body = (await (await makeApp()).inject({ method: 'GET', url: '/api/setup' })).json()
    expect(body.canFinish).toBe(true)
    expect(stepsOf(body).apollo).toMatchObject({ required: false, done: false, facts: { status: 'not_connected' } })
    expect(stepsOf(body).outreach).toMatchObject({ done: false, facts: { valid: false } })
  })

  it('a connection that failed its last check is not done', async () => {
    creds.describeConnector.mockResolvedValue({ ...connected, healthStatus: 'error' })
    const body = (await (await makeApp()).inject({ method: 'GET', url: '/api/setup' })).json()
    expect(stepsOf(body).salesforce).toMatchObject({ done: false, facts: { status: 'needs_attention' } })
    expect(body.canFinish).toBe(false)
  })

  it('reps away or inactive in Salesforce do not count', async () => {
    reps.listReps.mockResolvedValue([rep({ available: false }), rep({ sf_active: false })])
    const body = (await (await makeApp()).inject({ method: 'GET', url: '/api/setup' })).json()
    expect(stepsOf(body).reps.done).toBe(false)
  })
})

describe('POST /api/setup/complete', () => {
  it('stamps setup_completed_at when every required step is done', async () => {
    setup.markSetupCompleted.mockImplementation(async (_o: string, at: string) => at)
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/setup/complete' })
    expect(res.statusCode).toBe(200)
    expect(setup.markSetupCompleted).toHaveBeenCalledWith('org-a', expect.any(String))
    expect(res.json().completedAt).toBe(setup.markSetupCompleted.mock.calls[0][1])
  })

  it('missing steps → 409 SETUP_INCOMPLETE naming them, nothing stored', async () => {
    tests.countTestLeads.mockResolvedValue(0)
    creds.describeConnector.mockImplementation(async (_o: string, name: string) => (name === 'hubspot' ? notConnected : connected))
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/setup/complete' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'SETUP_INCOMPLETE', missing: ['hubspot', 'test_lead'], message: 'Finish these steps first: Connect HubSpot, Send a test lead.' })
    expect(setup.markSetupCompleted).not.toHaveBeenCalled()
  })

  it('members cannot finish setup', async () => {
    const res = await (await makeApp('member')).inject({ method: 'POST', url: '/api/setup/complete' })
    expect(res.statusCode).toBe(403)
    expect(setup.markSetupCompleted).not.toHaveBeenCalled()
  })
})
