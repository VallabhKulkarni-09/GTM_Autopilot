import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const repo = vi.hoisted(() => ({ describeAiModel: vi.fn(), loadAiModel: vi.fn(), saveAiModel: vi.fn(), deleteAiModel: vi.fn() }))
vi.mock('../../../src/repositories/ai-model.repository.js', () => repo)
const evalRepo = vi.hoisted(() => ({ createEvaluation: vi.fn(), getLatestEvaluation: vi.fn(), setQualificationAgent: vi.fn(), setRoutingAgent: vi.fn(), getEvaluation: vi.fn() }))
vi.mock('../../../src/repositories/ai-model-evaluation.repository.js', () => evalRepo)

const { createAiModelRoutes } = await import('../../../src/routes/api/ai-model.js')
const { ModelError } = await import('../../../src/models/types.js')

const resolver = async (h: string) => (h === 'evil.example' ? ['169.254.169.254'] : h === 'generativelanguage.googleapis.com' ? ['142.250.1.95'] : ['172.17.0.1'])
const chat = vi.fn()
const listModels = vi.fn()
const modelDigest = vi.fn()
const makeClient = vi.fn((cfg: { provider: string; model: string }) => ({ provider: cfg.provider, model: cfg.model, chat, listModels, modelDigest }))

async function makeApp() {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { req.tenantContext = { organizationId: 'org-a', userId: 'user-1', role: 'admin' } })
  await app.register(createAiModelRoutes({ makeClient: makeClient as never, resolver }), { prefix: '/api/ai-model' })
  await app.ready()
  return app
}

beforeEach(() => {
  Object.values(repo).forEach(f => f.mockReset())
  ;[chat, listModels, modelDigest, makeClient].forEach(f => f.mockClear())
  chat.mockResolvedValue({ text: '{"ok": true}', model: 'qwen2.5:1.5b', latencyMs: 12, provider: 'ollama', temperature: 0 })
  modelDigest.mockResolvedValue('sha-1')
  listModels.mockResolvedValue(['llama3.2:1b', 'qwen2.5:1.5b'])
  repo.loadAiModel.mockResolvedValue(null)
})

describe('AI model API', () => {
  it('GET never returns the key, flags cloud providers', async () => {
    repo.describeAiModel.mockResolvedValue({ provider: 'anthropic', base_url: null, model: 'claude-x', has_api_key: true, data_consent_at: '2026-10-27T00:00:00Z', data_consent_by: 'user-1', last_test_ok: true, last_test_at: '2026-10-27T00:00:00Z', updated_at: 'x' })
    const res = await (await makeApp()).inject({ method: 'GET', url: '/api/ai-model' })
    expect(res.json()).toMatchObject({ configured: true, provider: 'anthropic', hasApiKey: true, dataLeavesMachine: true, lastTest: { ok: true } })
    expect(res.body).not.toMatch(/secret|apiKey"/)
    expect(repo.describeAiModel).toHaveBeenCalledWith('org-a')
  })

  it('GET with nothing saved → configured false', async () => {
    repo.describeAiModel.mockResolvedValue(null)
    expect((await (await makeApp()).inject({ method: 'GET', url: '/api/ai-model' })).json()).toMatchObject({ configured: false, provider: null })
  })

  it('POST /models lists Ollama models; blocked address → 400 MODEL_URL_BLOCKED, no request made', async () => {
    const app = await makeApp()
    let res = await app.inject({ method: 'POST', url: '/api/ai-model/models', payload: { provider: 'ollama', baseUrl: 'http://host.docker.internal:11434' } })
    expect(res.json()).toEqual({ ok: true, models: ['llama3.2:1b', 'qwen2.5:1.5b'] })
    makeClient.mockClear()
    res = await app.inject({ method: 'POST', url: '/api/ai-model/models', payload: { provider: 'ollama', baseUrl: 'http://evil.example' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('MODEL_URL_BLOCKED')
    expect(makeClient).not.toHaveBeenCalled()
  })

  it('cloud providers ignore any base URL in the body and need a key', async () => {
    const app = await makeApp()
    let res = await app.inject({ method: 'POST', url: '/api/ai-model/test', payload: { provider: 'openai', model: 'gpt-x' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('API key')
    res = await app.inject({ method: 'POST', url: '/api/ai-model/test', payload: { provider: 'openai', model: 'gpt-x', apiKey: 'sk', baseUrl: 'http://evil.example' } })
    expect(res.json().ok).toBe(true)
    expect(makeClient).toHaveBeenCalledWith({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x', apiKey: 'sk' })
  })

  it('POST /test reports latency, digest and whether the model returned valid JSON', async () => {
    chat.mockResolvedValueOnce({ text: 'Sure! {ok}', model: 'qwen2.5:1.5b', latencyMs: 9 })
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/ai-model/test', payload: { provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'qwen2.5:1.5b' } })
    expect(res.json()).toEqual({ ok: true, leavesNetwork: false, latencyMs: 9, reportedModel: 'qwen2.5:1.5b', digest: 'sha-1', jsonOk: false })
    expect(chat.mock.calls[0][0]).toMatchObject({ json: true })
    expect(repo.saveAiModel).not.toHaveBeenCalled()
  })

  it('model failures come back as plain-language ok:false', async () => {
    chat.mockRejectedValueOnce(new ModelError('ollama', 'MODEL_UNREACHABLE', 0, {}, 'x'))
    const res = await (await makeApp()).inject({ method: 'POST', url: '/api/ai-model/test', payload: { provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'm' } })
    expect(res.json()).toMatchObject({ ok: false, error: 'MODEL_UNREACHABLE', message: 'Could not reach the model server.' })
  })

  it('PUT cloud without consent → 400 CONSENT_REQUIRED, nothing called', async () => {
    const res = await (await makeApp()).inject({ method: 'PUT', url: '/api/ai-model', payload: { provider: 'anthropic', model: 'claude-x', apiKey: 'ak' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('CONSENT_REQUIRED')
    expect(makeClient).not.toHaveBeenCalled()
    expect(repo.saveAiModel).not.toHaveBeenCalled()
  })

  it('PUT cloud with consent tests, then saves with the consenting user', async () => {
    const res = await (await makeApp()).inject({ method: 'PUT', url: '/api/ai-model', payload: { provider: 'anthropic', model: 'claude-x', apiKey: 'ak', consent: true } })
    expect(res.json()).toMatchObject({ ok: true, saved: true })
    expect(repo.saveAiModel).toHaveBeenCalledWith('org-a', { provider: 'anthropic', baseUrl: null, model: 'claude-x', apiKey: 'ak', consentBy: 'user-1', testOk: true, resetAgents: true })
  })

  it('PUT does not save when the live check fails', async () => {
    chat.mockRejectedValueOnce(new ModelError('ollama', 'MODEL_NOT_FOUND', 404, {}, 'x'))
    const res = await (await makeApp()).inject({ method: 'PUT', url: '/api/ai-model', payload: { provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'nope' } })
    expect(res.json()).toMatchObject({ ok: false, error: 'MODEL_NOT_FOUND' })
    expect(repo.saveAiModel).not.toHaveBeenCalled()
  })

  it('blank key reuses the saved one only for the same provider; Ollama never stores a key', async () => {
    repo.loadAiModel.mockResolvedValue({ provider: 'openrouter', apiKey: 'saved-key' })
    const app = await makeApp()
    await app.inject({ method: 'PUT', url: '/api/ai-model', payload: { provider: 'openrouter', model: 'x/y', consent: true } })
    expect(repo.saveAiModel.mock.calls[0][1]).toMatchObject({ apiKey: 'saved-key', baseUrl: null })
    const res = await app.inject({ method: 'PUT', url: '/api/ai-model', payload: { provider: 'openai', model: 'gpt-x', consent: true } })
    expect(res.statusCode).toBe(400)
    await app.inject({ method: 'PUT', url: '/api/ai-model', payload: { provider: 'ollama', baseUrl: 'http://host.docker.internal:11434/', model: 'qwen2.5:1.5b', apiKey: 'ignored' } })
    expect(repo.saveAiModel.mock.calls[1][1]).toEqual({ provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'qwen2.5:1.5b', apiKey: null, consentBy: null, testOk: true, resetAgents: true })
  })

  it('rejects unknown providers, extra fields and control characters in the model name', async () => {
    const app = await makeApp()
    for (const payload of [{ provider: 'gemini', model: 'x' }, { provider: 'ollama', model: 'x', organizationId: 'org-b' }, { provider: 'ollama', baseUrl: 'http://h', model: 'a\nb' }]) {
      expect((await app.inject({ method: 'PUT', url: '/api/ai-model', payload })).statusCode).toBe(400)
    }
  })

  it('Gemini is a cloud provider: Google base URL fixed in code, key + consent required', async () => {
    const app = await makeApp()
    let res = await app.inject({ method: 'PUT', url: '/api/ai-model', payload: { provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: 'AQ.k' } })
    expect(res.json().error).toBe('CONSENT_REQUIRED')
    res = await app.inject({ method: 'PUT', url: '/api/ai-model', payload: { provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: 'AQ.k', consent: true, baseUrl: 'http://evil.example' } })
    expect(res.json()).toMatchObject({ ok: true, saved: true })
    expect(makeClient).toHaveBeenCalledWith({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash-lite', apiKey: 'AQ.k' })
    expect(repo.saveAiModel.mock.calls.at(-1)?.[1]).toMatchObject({ provider: 'gemini', baseUrl: null, consentBy: 'user-1' })
  })

  it('"Other server" pointing at a public address needs consent and is recorded as leaving the network', async () => {
    const app = await makeApp()
    const payload = { provider: 'openai_compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash-lite', apiKey: 'k' }
    let res = await app.inject({ method: 'PUT', url: '/api/ai-model', payload })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'CONSENT_REQUIRED', message: expect.stringContaining('on the internet') })
    expect(makeClient).not.toHaveBeenCalled()
    res = await app.inject({ method: 'PUT', url: '/api/ai-model', payload: { ...payload, consent: true } })
    expect(repo.saveAiModel.mock.calls.at(-1)?.[1]).toMatchObject({ provider: 'openai_compatible', consentBy: 'user-1' })
    // Private address: no consent needed, none recorded.
    await app.inject({ method: 'PUT', url: '/api/ai-model', payload: { ...payload, baseUrl: 'http://host.docker.internal:1234/v1' } })
    expect(repo.saveAiModel.mock.calls.at(-1)?.[1]).toMatchObject({ consentBy: null })
    // GET reports where the data goes from the recorded consent.
    repo.describeAiModel.mockResolvedValue({ provider: 'openai_compatible', base_url: 'https://x', model: 'm', has_api_key: true, data_consent_at: '2026-10-27T00:00:00Z', data_consent_by: 'user-1', last_test_ok: true, last_test_at: 'x', qualification_agent_enabled: false, qualification_evaluation_id: null, updated_at: 'x' })
    expect((await app.inject({ method: 'GET', url: '/api/ai-model' })).json().dataLeavesMachine).toBe(true)
  })

  it('DELETE removes only this workspace', async () => {
    const res = await (await makeApp()).inject({ method: 'DELETE', url: '/api/ai-model' })
    expect(res.statusCode).toBe(204)
    expect(repo.deleteAiModel).toHaveBeenCalledWith('org-a')
  })
})

describe('AI model test leads + agent switch', () => {
  const ROW = { provider: 'ollama', base_url: 'http://h', model: 'qwen2.5:1.5b', has_api_key: false, qualification_agent_enabled: false, qualification_evaluation_id: null }
  const enqueue = vi.fn(async () => {})
  async function appWithQueue() {
    const app = Fastify({ logger: false })
    app.addHook('onRequest', async req => { req.tenantContext = { organizationId: 'org-a', userId: 'user-1', role: 'admin' } })
    await app.register(createAiModelRoutes({ makeClient: makeClient as never, resolver, enqueueEvaluation: enqueue }), { prefix: '/api/ai-model' })
    return app
  }
  const run = async (over: Record<string, unknown> = {}) => {
    const { PROMPT_VERSION } = await import('../../../src/agents/qualification/prompt.js')
    const { QUALIFICATION_V2_VERSION } = await import('../../../src/agents/qualification/llm.js')
    return { id: 'ev1', status: 'completed', provider: 'ollama', model: 'qwen2.5:1.5b', model_digest: 'd', prompt_version: PROMPT_VERSION, agent_version: QUALIFICATION_V2_VERSION, dataset_version: 'x', summary: { agreed: 30, total: 45 }, results: [{ caseId: 'a', agrees: false, description: 'd', expected: 'tier_1', actual: 'tier_2', outcome: 'model', review: false, fallbackReason: null }, { caseId: 'b', agrees: true }], error: null, started_at: 's', completed_at: 'c', ...over }
  }
  beforeEach(() => { enqueue.mockClear(); evalRepo.createEvaluation.mockReset(); evalRepo.getLatestEvaluation.mockReset(); evalRepo.setQualificationAgent.mockReset() })

  it('POST /evaluations creates a run for the saved model and enqueues it; 409 while one is running; 404 with no model', async () => {
    repo.describeAiModel.mockResolvedValue(ROW)
    evalRepo.createEvaluation.mockResolvedValueOnce(await run({ status: 'running', results: null }))
    const app = await appWithQueue()
    let res = await app.inject({ method: 'POST', url: '/api/ai-model/evaluations' })
    expect(res.statusCode).toBe(202)
    expect(evalRepo.createEvaluation.mock.calls[0][0]).toBe('org-a')
    expect(evalRepo.createEvaluation.mock.calls[0][1]).toMatchObject({ provider: 'ollama', model: 'qwen2.5:1.5b', requested_by: 'user-1' })
    expect(enqueue).toHaveBeenCalledWith('org-a', 'ev1')
    evalRepo.createEvaluation.mockResolvedValueOnce(null)
    res = await app.inject({ method: 'POST', url: '/api/ai-model/evaluations' })
    expect(res.statusCode).toBe(409)
    repo.describeAiModel.mockResolvedValue(null)
    expect((await app.inject({ method: 'POST', url: '/api/ai-model/evaluations' })).statusCode).toBe(404)
  })

  it('GET /evaluations/latest returns the summary and only the misses', async () => {
    repo.describeAiModel.mockResolvedValue(ROW)
    evalRepo.getLatestEvaluation.mockResolvedValue(await run())
    const res = await (await appWithQueue()).inject({ method: 'GET', url: '/api/ai-model/evaluations/latest' })
    expect(res.json()).toMatchObject({ matchesCurrentModel: true, evaluation: { summary: { agreed: 30 }, misses: [{ caseId: 'a' }] } })
    expect(res.json().evaluation.misses).toHaveLength(1)
  })

  it('PUT /agents on needs a completed run for this exact model + prompt + agent version', async () => {
    repo.describeAiModel.mockResolvedValue(ROW)
    const app = await appWithQueue()
    for (const r of [null, await run({ status: 'running' }), await run({ model: 'llama3.2:1b' }), await run({ prompt_version: 'qualification-v1' })]) {
      evalRepo.getLatestEvaluation.mockResolvedValueOnce(r)
      const res = await app.inject({ method: 'PUT', url: '/api/ai-model/agents', payload: { qualification: true } })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('EVALUATION_REQUIRED')
    }
    expect(evalRepo.setQualificationAgent).not.toHaveBeenCalled()
    evalRepo.getLatestEvaluation.mockResolvedValueOnce(await run())
    repo.describeAiModel.mockResolvedValueOnce(ROW).mockResolvedValueOnce({ ...ROW, qualification_agent_enabled: true })
    const ok = await app.inject({ method: 'PUT', url: '/api/ai-model/agents', payload: { qualification: true } })
    expect(ok.json()).toEqual({ qualificationAgentEnabled: true, routingAgentEnabled: false, evaluationId: 'ev1' })
    expect(evalRepo.setQualificationAgent).toHaveBeenCalledWith('org-a', true, 'ev1')
    await app.inject({ method: 'PUT', url: '/api/ai-model/agents', payload: { qualification: false } })
    expect(evalRepo.setQualificationAgent).toHaveBeenLastCalledWith('org-a', false, null)
  })

  it('routing switch is gated on the run\'s routing versions; a refused request changes nothing', async () => {
    repo.describeAiModel.mockResolvedValue(ROW)
    const app = await appWithQueue()
    evalRepo.getLatestEvaluation.mockResolvedValueOnce(await run({ routing_prompt_version: null, routing_agent_version: null }))
    let res = await app.inject({ method: 'PUT', url: '/api/ai-model/agents', payload: { qualification: true, routing: true } })
    expect(res.statusCode).toBe(409)
    expect(evalRepo.setQualificationAgent).not.toHaveBeenCalled()
    expect(evalRepo.setRoutingAgent).not.toHaveBeenCalled()
    const { ROUTING_PROMPT_VERSION, ROUTING_V2_VERSION } = await import('../../../src/agents/routing/llm.js')
    evalRepo.getLatestEvaluation.mockResolvedValueOnce(await run({ routing_prompt_version: ROUTING_PROMPT_VERSION, routing_agent_version: ROUTING_V2_VERSION }))
    res = await app.inject({ method: 'PUT', url: '/api/ai-model/agents', payload: { routing: true } })
    expect(res.statusCode).toBe(200)
    expect(evalRepo.setRoutingAgent).toHaveBeenCalledWith('org-a', true, 'ev1')
    expect(evalRepo.setQualificationAgent).not.toHaveBeenCalled()
    expect((await app.inject({ method: 'PUT', url: '/api/ai-model/agents', payload: {} })).statusCode).toBe(400)
  })

  it('saving a different model turns the agent off; re-saving the same one keeps it', async () => {
    const app = await appWithQueue()
    repo.describeAiModel.mockResolvedValue({ ...ROW, base_url: 'http://host.docker.internal:11434', qualification_agent_enabled: true })
    let res = await app.inject({ method: 'PUT', url: '/api/ai-model', payload: { provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'qwen2.5:1.5b' } })
    expect(repo.saveAiModel.mock.calls.at(-1)?.[1].resetAgents).toBe(false)
    expect(res.json().agentsTurnedOff).toBe(false)
    res = await app.inject({ method: 'PUT', url: '/api/ai-model', payload: { provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'llama3.2:1b' } })
    expect(repo.saveAiModel.mock.calls.at(-1)?.[1].resetAgents).toBe(true)
    expect(res.json().agentsTurnedOff).toBe(true)
  })
})
