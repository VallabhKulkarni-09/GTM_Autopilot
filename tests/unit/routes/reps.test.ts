import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const repo = vi.hoisted(() => ({
  listReps: vi.fn(), insertRep: vi.fn(), updateRepMetadata: vi.fn(),
  listActivePolicies: vi.fn(), insertPolicy: vi.fn(), updatePolicy: vi.fn(),
}))
vi.mock('../../../src/repositories/reps.repository.js', () => repo)
vi.mock('../../../src/connectors/factory.js', () => ({ getConnectors: vi.fn() }))

const { createRepRoutes, territoryRoutes } = await import('../../../src/routes/api/reps.js')
const { ConnectorError } = await import('../../../src/connectors/base.js')

const REP_A = '11111111-1111-4111-8111-111111111111'
const REP_B = '22222222-2222-4222-8222-222222222222'
const T1 = '33333333-3333-4333-8333-333333333333'
const meta = (name: string, over = {}) => ({ name, email: `${name}@x.com`, title: null, available: true, sf_active: true, imported_at: '', ...over })

const loadSalesforceUsers = vi.fn()

async function makeApp() {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { req.tenantContext = { organizationId: 'org-a', userId: 'u', role: 'admin' } })
  await app.register(createRepRoutes({ loadSalesforceUsers }), { prefix: '/api/reps' })
  await app.register(territoryRoutes, { prefix: '/api/territories' })
  await app.ready()
  return app
}

beforeEach(() => {
  Object.values(repo).forEach(f => f.mockReset())
  loadSalesforceUsers.mockReset()
  repo.listReps.mockResolvedValue([
    { id: REP_A, external_id: '005A', metadata: meta('Alice') },
    { id: REP_B, external_id: '005B', metadata: meta('Bob', { available: false }) },
  ])
  repo.listActivePolicies.mockResolvedValue([])
  repo.updateRepMetadata.mockImplementation(async (_o: string, id: string, m: unknown) => ({ id, external_id: 'x', metadata: m }))
})

describe('reps API', () => {
  it('lists reps without Salesforce IDs', async () => {
    const res = await (await makeApp()).inject({ method: 'GET', url: '/api/reps' })
    expect(res.json().reps).toEqual([
      { id: REP_A, name: 'Alice', email: 'Alice@x.com', title: null, available: true, activeInSalesforce: true },
      { id: REP_B, name: 'Bob', email: 'Bob@x.com', title: null, available: false, activeInSalesforce: true },
    ])
    expect(res.body).not.toContain('005A')
    expect(repo.listReps).toHaveBeenCalledWith('org-a')
  })

  it('import adds new users, refreshes existing ones (keeping availability) and flags removed ones', async () => {
    loadSalesforceUsers.mockResolvedValue([
      { Id: '005B', Name: 'Bob Jones', Email: 'bob@x.com', IsActive: true, UserRole: { Name: 'AE' }, Profile: null },
      { Id: '005C', Name: 'Cara', Email: 'cara@x.com', IsActive: true, UserRole: null, Profile: null },
    ])
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/reps/import' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ added: 1, updated: 1, deactivated: 1 })
    expect(loadSalesforceUsers).toHaveBeenCalledWith('org-a')
    expect(repo.insertRep).toHaveBeenCalledWith('org-a', '005C', expect.objectContaining({ name: 'Cara', available: true, sf_active: true }))
    expect(repo.updateRepMetadata).toHaveBeenCalledWith('org-a', REP_B, expect.objectContaining({ name: 'Bob Jones', title: 'AE', available: false, sf_active: true }))
    expect(repo.updateRepMetadata).toHaveBeenCalledWith('org-a', REP_A, expect.objectContaining({ sf_active: false }))
  })

  it('import without Salesforce connected → 409', async () => {
    loadSalesforceUsers.mockResolvedValue(null)
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/reps/import' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('SALESFORCE_NOT_CONNECTED')
  })

  it('import surfaces Salesforce errors in plain language', async () => {
    loadSalesforceUsers.mockRejectedValue(new ConnectorError('salesforce', 'SF_USER_QUERY_FAILED', 403, {}, 'nope'))
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/reps/import' })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ error: 'SF_USER_QUERY_FAILED', fix: expect.stringContaining('Users') })
  })

  it('PATCH sets availability; unknown/cross-tenant rep → 404', async () => {
    const app = await makeApp()
    const ok = await app.inject({ method: 'PATCH', url: `/api/reps/${REP_A}`, payload: { available: false } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().available).toBe(false)
    expect(repo.updateRepMetadata).toHaveBeenCalledWith('org-a', REP_A, expect.objectContaining({ available: false, name: 'Alice' }))
    const other = await app.inject({ method: 'PATCH', url: '/api/reps/44444444-4444-4444-8444-444444444444', payload: { available: true } })
    expect(other.statusCode).toBe(404)
  })

  it('settings read and save max open leads with version check', async () => {
    repo.listActivePolicies.mockResolvedValue([{ id: 'r', name: 'Lead assignment', version: 2, priority: 40, conditions: {}, actions: { max_open_leads_per_rep: 25 } }])
    repo.updatePolicy.mockResolvedValue({ id: 'r', version: 3 })
    const app = await makeApp()
    expect((await app.inject({ method: 'GET', url: '/api/reps/settings' })).json()).toEqual({ version: 2, maxOpenLeadsPerRep: 25 })
    const saved = await app.inject({ method: 'PUT', url: '/api/reps/settings', payload: { maxOpenLeadsPerRep: 10, version: 2 } })
    expect(saved.json()).toEqual({ version: 3, maxOpenLeadsPerRep: 10 })
    expect(repo.updatePolicy).toHaveBeenCalledWith('org-a', 'routing', 'r', 2, { actions: { max_open_leads_per_rep: 10 } })
    expect((await app.inject({ method: 'PUT', url: '/api/reps/settings', payload: { maxOpenLeadsPerRep: 10, version: 1 } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'PUT', url: '/api/reps/settings', payload: { maxOpenLeadsPerRep: 0, version: 2 } })).statusCode).toBe(400)
  })
})

describe('territories API', () => {
  it('creates a territory in the existing rule shape, mapping rep IDs to Salesforce IDs', async () => {
    repo.insertPolicy.mockImplementation(async (_o: string, _t: string, row: any) => ({ id: T1, version: 1, ...row }))
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/territories', payload: { name: 'North America', countries: ['us', 'CA'], repIds: [REP_A] } })
    expect(res.statusCode).toBe(201)
    expect(repo.insertPolicy).toHaveBeenCalledWith('org-a', 'territory', expect.objectContaining({
      conditions: { field: 'country', operator: 'in', values: ['US', 'CA'] },
      actions: { queue_name: 'north-america', owner_ids: ['005A'] },
      priority: 10,
    }))
    expect(res.json()).toMatchObject({ name: 'North America', countries: ['US', 'CA'], repIds: [REP_A], missingReps: 0 })
  })

  it('rejects reps from another workspace, duplicate names and empty lists', async () => {
    repo.listActivePolicies.mockResolvedValue([{ id: T1, name: 'EMEA', version: 1, priority: 10, conditions: { operator: 'all' }, actions: { queue_name: 'emea', owner_ids: null } }])
    const app = await makeApp()
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/territories', payload })
    expect((await post({ name: 'X', countries: null, repIds: ['44444444-4444-4444-8444-444444444444'] })).json().error).toBe('REP_NOT_FOUND')
    expect((await post({ name: 'emea', countries: null, repIds: null })).json().error).toBe('TERRITORY_NAME_TAKEN')
    expect((await post({ name: 'Y', countries: [], repIds: null })).json().error).toBe('TERRITORY_COUNTRIES_EMPTY')
    expect((await post({ name: 'Y', countries: null, repIds: [] })).json().error).toBe('TERRITORY_REPS_EMPTY')
    expect((await post({ name: 'Y', countries: ['USA'], repIds: null })).statusCode).toBe(400)
    expect(repo.insertPolicy).not.toHaveBeenCalled()
  })

  it('updates and deletes only territories in this workspace', async () => {
    repo.listActivePolicies.mockResolvedValue([{ id: T1, name: 'EMEA', version: 4, priority: 10, conditions: { operator: 'all' }, actions: { queue_name: 'emea', owner_ids: null } }])
    repo.updatePolicy.mockImplementation(async (_o: string, _t: string, id: string, v: number, ch: any) => ({ id, version: v + 1, name: ch.name ?? 'EMEA', priority: 10, conditions: ch.conditions ?? {}, actions: ch.actions ?? null }))
    const app = await makeApp()
    const put = await app.inject({ method: 'PUT', url: `/api/territories/${T1}`, payload: { name: 'EMEA', countries: ['DE'], repIds: null } })
    expect(put.statusCode).toBe(200)
    expect(repo.updatePolicy).toHaveBeenCalledWith('org-a', 'territory', T1, 4, expect.objectContaining({ conditions: { field: 'country', operator: 'in', values: ['DE'] } }))
    const del = await app.inject({ method: 'DELETE', url: `/api/territories/${T1}` })
    expect(del.statusCode).toBe(204)
    expect(repo.updatePolicy).toHaveBeenLastCalledWith('org-a', 'territory', T1, 4, { is_active: false })
    const missing = await app.inject({ method: 'DELETE', url: '/api/territories/44444444-4444-4444-8444-444444444444' })
    expect(missing.statusCode).toBe(404)
  })
})
