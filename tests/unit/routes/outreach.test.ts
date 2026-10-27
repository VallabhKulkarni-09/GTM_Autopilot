import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const repo = vi.hoisted(() => ({
  listReps: vi.fn(), insertRep: vi.fn(), updateRepMetadata: vi.fn(),
  listActivePolicies: vi.fn(), insertPolicy: vi.fn(), updatePolicy: vi.fn(),
}))
vi.mock('../../../src/repositories/reps.repository.js', () => repo)
vi.mock('../../../src/connectors/factory.js', () => ({ getConnectors: vi.fn() }))

const { createOutreachRoutes } = await import('../../../src/routes/api/outreach.js')
const { ConnectorError } = await import('../../../src/connectors/base.js')

const CONFIG = {
  email_account: { id: 'acct_1', email: 'sdr@acme.io' },
  tiers: { tier_1: { mode: 'sequence', sequence_id: 'seq_1', sequence_name: 'Great fit' }, tier_2: { mode: 'manual' } },
}
const ROW = { id: 'pol_out', name: 'Outreach', version: 3, priority: 50, conditions: {}, actions: CONFIG }

const loadApolloOptions = vi.fn()

async function makeApp() {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { req.tenantContext = { organizationId: 'org-a', userId: 'u', role: 'admin' } })
  await app.register(createOutreachRoutes({ loadApolloOptions }), { prefix: '/api/outreach' })
  await app.ready()
  return app
}

beforeEach(() => {
  Object.values(repo).forEach(f => f.mockReset())
  loadApolloOptions.mockReset()
  repo.listActivePolicies.mockResolvedValue([ROW])
  repo.updatePolicy.mockImplementation(async (_o: string, _t: string, id: string, v: number, ch: { actions: unknown }) => ({ ...ROW, id, version: v + 1, actions: ch.actions }))
})

describe('outreach API', () => {
  it('GET returns the org policy, scoped to the tenant', async () => {
    const res = await (await makeApp()).inject({ method: 'GET', url: '/api/outreach' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'pol_out', version: 3, config: CONFIG })
    expect(repo.listActivePolicies).toHaveBeenCalledWith('org-a', 'outreach')
  })

  it('GET with no policy → 404 OUTREACH_POLICY_MISSING; corrupt row → 422', async () => {
    repo.listActivePolicies.mockResolvedValueOnce([])
    let res = await (await makeApp()).inject({ method: 'GET', url: '/api/outreach' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('OUTREACH_POLICY_MISSING')
    repo.listActivePolicies.mockResolvedValueOnce([{ ...ROW, actions: { tiers: 1 } }])
    res = await (await makeApp()).inject({ method: 'GET', url: '/api/outreach' })
    expect(res.statusCode).toBe(422)
  })

  it('PUT saves with the version check and bumps the version', async () => {
    const res = await (await makeApp()).inject({ method: 'PUT', url: '/api/outreach', payload: { config: CONFIG, version: 3 } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ version: 4, config: CONFIG })
    expect(repo.updatePolicy).toHaveBeenCalledWith('org-a', 'outreach', 'pol_out', 3, { actions: CONFIG })
  })

  it('PUT keeps sequence fields (oneOf + removeAdditional does not strip them)', async () => {
    await (await makeApp()).inject({ method: 'PUT', url: '/api/outreach', payload: { config: CONFIG, version: 3 } })
    const saved = repo.updatePolicy.mock.calls[0][4].actions
    expect(saved.tiers.tier_1).toEqual({ mode: 'sequence', sequence_id: 'seq_1', sequence_name: 'Great fit' })
  })

  it('PUT with a stale version → 409, nothing saved', async () => {
    const res = await (await makeApp()).inject({ method: 'PUT', url: '/api/outreach', payload: { config: CONFIG, version: 2 } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('POLICY_VERSION_CONFLICT')
    expect(repo.updatePolicy).not.toHaveBeenCalled()
  })

  it('PUT with a sequence but no mailbox → 400 with a plain-language issue', async () => {
    const res = await (await makeApp()).inject({ method: 'PUT', url: '/api/outreach', payload: { config: { ...CONFIG, email_account: null }, version: 3 } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'OUTREACH_POLICY_INVALID', issues: ['pick the mailbox Apollo should send from'] })
  })

  it('PUT ignores organizationId in the body; the org comes from the verified user', async () => {
    await (await makeApp()).inject({ method: 'PUT', url: '/api/outreach', payload: { config: CONFIG, version: 3, organizationId: 'org-b' } })
    expect(repo.listActivePolicies).toHaveBeenCalledWith('org-a', 'outreach')
    expect(repo.updatePolicy).toHaveBeenCalledWith('org-a', 'outreach', 'pol_out', 3, { actions: CONFIG })
  })

  it('GET /options returns Apollo sequences and mailboxes for this org', async () => {
    loadApolloOptions.mockResolvedValue({ sequences: [{ id: 'seq_1', name: 'Great fit', active: true }], emailAccounts: [] })
    const res = await (await makeApp()).inject({ method: 'GET', url: '/api/outreach/options' })
    expect(res.statusCode).toBe(200)
    expect(res.json().sequences).toHaveLength(1)
    expect(loadApolloOptions).toHaveBeenCalledWith('org-a')
  })

  it('GET /options: Apollo not connected → 409; key lacks scope → 502 with a fix', async () => {
    loadApolloOptions.mockResolvedValueOnce(null)
    let res = await (await makeApp()).inject({ method: 'GET', url: '/api/outreach/options' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('APOLLO_NOT_CONNECTED')

    loadApolloOptions.mockRejectedValueOnce(new ConnectorError('apollo', 'AP_INSUFFICIENT_SCOPE', 403, 'nope', 'scope'))
    res = await (await makeApp()).inject({ method: 'GET', url: '/api/outreach/options' })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ error: 'AP_INSUFFICIENT_SCOPE', fix: expect.stringContaining('master API key') })
    expect(res.body).not.toContain('nope')
  })
})
