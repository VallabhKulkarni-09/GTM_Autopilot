import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { DEFAULT_ICP_CONFIG } from '../../../src/agents/qualification/icp-config'

const repo = vi.hoisted(() => ({ getActiveIcpPolicy: vi.fn(), updateIcpPolicy: vi.fn() }))
vi.mock('../../../src/repositories/icp-policy.repository.js', () => repo)

const { icpRoutes } = await import('../../../src/routes/api/icp.js')

const row = { id: 'p1', version: 2, conditions: { ...DEFAULT_ICP_CONFIG }, updated_at: '2026-10-26T00:00:00Z' }

async function makeApp(role: 'admin' | 'member' = 'admin') {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { req.tenantContext = { organizationId: 'org-a', userId: 'u', role } })
  await app.register(icpRoutes, { prefix: '/api/icp' })
  await app.ready()
  return app
}

beforeEach(() => {
  repo.getActiveIcpPolicy.mockReset().mockResolvedValue(row)
  repo.updateIcpPolicy.mockReset()
})

describe('ICP API', () => {
  it('GET returns the org config, scoped by tenant org', async () => {
    const res = await (await makeApp('member')).inject({ method: 'GET', url: '/api/icp' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'p1', version: 2, config: DEFAULT_ICP_CONFIG })
    expect(repo.getActiveIcpPolicy).toHaveBeenCalledWith('org-a')
  })

  it('GET returns 404 when the org has no policy', async () => {
    repo.getActiveIcpPolicy.mockResolvedValue(null)
    const res = await (await makeApp()).inject({ method: 'GET', url: '/api/icp' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('ICP_POLICY_MISSING')
  })

  it('PUT is admin-only', async () => {
    const res = await (await makeApp('member')).inject({ method: 'PUT', url: '/api/icp', payload: { config: DEFAULT_ICP_CONFIG, version: 2 } })
    expect(res.statusCode).toBe(403)
    expect(repo.updateIcpPolicy).not.toHaveBeenCalled()
  })

  it('PUT validates and saves with the expected version', async () => {
    const config = { ...DEFAULT_ICP_CONFIG, countries: ['in'] }
    repo.updateIcpPolicy.mockResolvedValue({ ...row, version: 3, conditions: config })
    const res = await (await makeApp()).inject({ method: 'PUT', url: '/api/icp', payload: { config, version: 2 } })
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toBe(3)
    expect(repo.updateIcpPolicy).toHaveBeenCalledWith('org-a', 'p1', 2, expect.objectContaining({ countries: ['IN'] }))
  })

  it('PUT rejects invalid config with issues', async () => {
    const res = await (await makeApp()).inject({ method: 'PUT', url: '/api/icp', payload: { config: { ...DEFAULT_ICP_CONFIG, employee_min: -1 }, version: 2 } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('ICP_CONFIG_INVALID')
    expect(repo.updateIcpPolicy).not.toHaveBeenCalled()
  })

  it('PUT returns 409 on a stale version', async () => {
    const res = await (await makeApp()).inject({ method: 'PUT', url: '/api/icp', payload: { config: DEFAULT_ICP_CONFIG, version: 1 } })
    expect(res.statusCode).toBe(409)
    repo.updateIcpPolicy.mockResolvedValue(null)
    const raced = await (await makeApp()).inject({ method: 'PUT', url: '/api/icp', payload: { config: DEFAULT_ICP_CONFIG, version: 2 } })
    expect(raced.statusCode).toBe(409)
  })

  it('preview scores a sample lead with the saved config and labels the fit', async () => {
    const res = await (await makeApp('member')).inject({
      method: 'POST', url: '/api/icp/preview',
      payload: { lead: { email: 'a@acme.com', title: 'VP Sales', source: 'demo' }, company: { industry: 'SaaS', employee_count: 300, country: 'US' } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ icp_tier: 'tier_1', icp_score: 100, fit_label: 'Great fit', is_icp_fit: true })
  })

  it('preview uses unsaved config when provided', async () => {
    const res = await (await makeApp()).inject({
      method: 'POST', url: '/api/icp/preview',
      payload: { config: { ...DEFAULT_ICP_CONFIG, industries: ['retail'] }, lead: { email: 'a@acme.com' }, company: { industry: 'SaaS', employee_count: 300, country: 'US' } },
    })
    expect(res.json()).toMatchObject({ icp_tier: 'tier_2', fit_label: 'Good fit' })
    expect(repo.getActiveIcpPolicy).not.toHaveBeenCalled()
  })

  it('preview with no company returns Not a fit', async () => {
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/icp/preview', payload: { lead: { email: 'a@gmail.com' }, company: null } })
    expect(res.json()).toMatchObject({ icp_tier: 'not_icp', fit_label: 'Not a fit' })
  })
})
