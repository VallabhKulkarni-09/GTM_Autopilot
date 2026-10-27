import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const repo = vi.hoisted(() => ({
  describeConnector: vi.fn(),
  loadConnectorCredentials: vi.fn(),
  saveConnectorCredentials: vi.fn(),
  recordHealth: vi.fn(),
  findOrgByHubspotPortal: vi.fn(),
}))
vi.mock('../../../src/repositories/connector-credentials.repository.js', () => ({
  V1_CONNECTORS: ['hubspot', 'salesforce', 'apollo'],
  ...repo,
}))
vi.mock('../../../src/connectors/factory.js', () => ({ invalidateConnectors: vi.fn() }))

const { createConnectorRoutes } = await import('../../../src/routes/api/connectors.js')

const test = vi.fn()
async function makeApp() {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { req.tenantContext = { organizationId: 'org-a', userId: 'u', role: 'admin' } })
  await app.register(createConnectorRoutes({ test }), { prefix: '/api/connectors' })
  await app.ready()
  return app
}

beforeEach(() => {
  Object.values(repo).forEach(f => f.mockReset())
  test.mockReset()
  repo.loadConnectorCredentials.mockResolvedValue(null)
})

describe('connectors API (v1)', () => {
  it('lists only HubSpot, Salesforce and Apollo, without secrets', async () => {
    repo.describeConnector.mockImplementation(async (_o: string, name: string) =>
      name === 'hubspot'
        ? { configured: true, public: { portal_id: '123' }, healthStatus: 'healthy', lastCheckedAt: '2026-10-25T00:00:00Z' }
        : { configured: false, public: {}, healthStatus: null, lastCheckedAt: null })
    const res = await (await makeApp()).inject({ method: 'GET', url: '/api/connectors' })
    expect(res.json()).toEqual([
      { name: 'hubspot', status: 'connected', details: { portal_id: '123' }, lastChecked: '2026-10-25T00:00:00Z' },
      { name: 'salesforce', status: 'not_connected', details: {}, lastChecked: null },
      { name: 'apollo', status: 'not_connected', details: {}, lastChecked: null },
    ])
  })

  it('rejects connectors outside v1 scope', async () => {
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/connectors/outreach/save', payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('names missing fields in plain language', async () => {
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/connectors/apollo/test', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBe('Please fill in: API key.')
  })

  it('save: stores credentials only after a successful live test', async () => {
    test.mockResolvedValue({ ok: true, latencyMs: 5, credentials: { public: {}, secrets: { apiKey: 'k' } }, details: {} })
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/connectors/apollo/save', payload: { apiKey: 'k' } })
    expect(res.json()).toMatchObject({ ok: true, saved: true })
    expect(repo.saveConnectorCredentials).toHaveBeenCalledWith('org-a', 'apollo', { public: {}, secrets: { apiKey: 'k' } })
  })

  it('save: does not store failing credentials and returns the reason', async () => {
    test.mockResolvedValue({ ok: false, latencyMs: 5, error: 'AP_AUTH_FAILED', message: 'Apollo rejected the API key' })
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/connectors/apollo/save', payload: { apiKey: 'bad' } })
    expect(res.json()).toMatchObject({ ok: false, error: 'AP_AUTH_FAILED', message: 'Apollo did not accept the API key.' })
    expect(res.json().fix).toContain('Apollo')
    expect(repo.saveConnectorCredentials).not.toHaveBeenCalled()
  })

  it('save: refuses a HubSpot portal already owned by another workspace', async () => {
    test.mockResolvedValue({ ok: true, latencyMs: 5, credentials: { public: { portal_id: '123' }, secrets: { apiKey: 'k', webhookSecret: 's' } }, details: {} })
    repo.findOrgByHubspotPortal.mockResolvedValue('org-b')
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/connectors/hubspot/save', payload: { apiKey: 'k', webhookSecret: 's' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('PORTAL_IN_USE')
    expect(repo.saveConnectorCredentials).not.toHaveBeenCalled()
  })

  it('re-test without retyping: blank secret fields fall back to saved values', async () => {
    repo.loadConnectorCredentials.mockResolvedValue({ public: {}, secrets: { apiKey: 'saved-key' } })
    test.mockResolvedValue({ ok: true, latencyMs: 1, credentials: {}, details: {} })
    await (await makeApp()).inject({ method: 'POST', url: '/api/connectors/apollo/test', payload: { apiKey: '' } })
    expect(test).toHaveBeenCalledWith('apollo', { public: {}, secrets: { apiKey: 'saved-key' } })
  })
})
