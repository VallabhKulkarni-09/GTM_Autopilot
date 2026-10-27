/** The gate between "model saved" and "model decides", and the golden-set job. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const evalRepo = vi.hoisted(() => ({
  getEvaluation: vi.fn(), completeEvaluation: vi.fn(), failEvaluation: vi.fn(), updateEvaluationProgress: vi.fn(),
}))
const aiRepo = vi.hoisted(() => ({ loadAiModel: vi.fn() }))
vi.mock('../../src/repositories/ai-model-evaluation.repository.js', () => evalRepo)
vi.mock('../../src/repositories/ai-model.repository.js', () => aiRepo)

const { chooseQualificationModel } = await import('../../src/workflows/inbound-lead/qualification-model.js')
const { processEvaluateModel } = await import('../../src/queue/jobs/evaluate-model.js')
const { PROMPT_VERSION } = await import('../../src/agents/qualification/prompt.js')
const { QUALIFICATION_V2_VERSION } = await import('../../src/agents/qualification/llm.js')
const { ModelError } = await import('../../src/models/types.js')
const { GOLDEN_CASES } = await import('../../src/evaluation/datasets/golden.js')

const SAVED = { provider: 'ollama', base_url: 'http://host.docker.internal:11434', model: 'qwen2.5:1.5b', apiKey: null, qualification_agent_enabled: true, qualification_evaluation_id: 'ev1' }
const RUN = { id: 'ev1', status: 'completed', provider: 'ollama', model: 'qwen2.5:1.5b', model_digest: 'd1', prompt_version: PROMPT_VERSION, agent_version: QUALIFICATION_V2_VERSION }

const client = (over: Record<string, unknown> = {}) => ({
  provider: 'ollama', model: 'qwen2.5:1.5b', listModels: vi.fn(), modelDigest: vi.fn(async () => 'd1'),
  chat: vi.fn(async () => ({ text: '{"industry":"yes","country":"yes","title":"no","intent":"no","suspicious":false,"confidence":0.8}', model: 'qwen2.5:1.5b', latencyMs: 3 })),
  ...over,
})
const deps = (saved: unknown, run: unknown, c = client()) => ({ load: vi.fn(async () => saved), getRun: vi.fn(async () => run), makeClient: vi.fn(() => c) }) as never

describe('chooseQualificationModel', () => {
  it('off when nothing saved or the switch is off (no event, no model call)', async () => {
    expect(await chooseQualificationModel('org', deps(null, null))).toEqual({ kind: 'off' })
    expect(await chooseQualificationModel('org', deps({ ...SAVED, qualification_agent_enabled: false }, RUN))).toEqual({ kind: 'off' })
  })

  it('on with the evaluated digest when the run matches', async () => {
    const d = deps(SAVED, RUN)
    const c = await chooseQualificationModel('org-a', d)
    expect(c).toMatchObject({ kind: 'on', modelDigest: 'd1', evaluatedDigest: 'd1', evaluationId: 'ev1' })
    expect((d as any).getRun).toHaveBeenCalledWith('org-a', 'ev1')
    expect((d as any).makeClient).toHaveBeenCalledWith({ provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'qwen2.5:1.5b', apiKey: null })
  })

  it('fallback (explicit reason) when the gate no longer holds or the server is down', async () => {
    expect(await chooseQualificationModel('org', deps(SAVED, null))).toMatchObject({ kind: 'fallback', reason: 'MODEL_EVALUATION_MISSING' })
    expect(await chooseQualificationModel('org', deps(SAVED, { ...RUN, model: 'other' }))).toMatchObject({ kind: 'fallback', reason: 'MODEL_EVALUATION_MISSING' })
    expect(await chooseQualificationModel('org', deps(SAVED, { ...RUN, prompt_version: 'old' }))).toMatchObject({ kind: 'fallback', reason: 'MODEL_EVALUATION_OUTDATED' })
    const down = client({ modelDigest: vi.fn(async () => { throw new ModelError('ollama', 'MODEL_UNREACHABLE', 0, {}, 'x') }) })
    expect(await chooseQualificationModel('org', deps(SAVED, RUN, down))).toMatchObject({ kind: 'fallback', reason: 'MODEL_UNREACHABLE', provider: 'ollama' })
  })
})

describe('processEvaluateModel', () => {
  beforeEach(() => { Object.values(evalRepo).forEach(f => f.mockReset()); aiRepo.loadAiModel.mockReset() })

  it('runs every golden case and stores the summary + digest', async () => {
    evalRepo.getEvaluation.mockResolvedValue({ ...RUN, status: 'running' })
    aiRepo.loadAiModel.mockResolvedValue(SAVED)
    const c = client()
    expect(await processEvaluateModel({ organizationId: 'org-a', evaluationId: 'ev1' }, { makeClient: () => c as never })).toEqual({ status: 'completed' })
    const [org, id, r] = evalRepo.completeEvaluation.mock.calls[0]
    expect([org, id, r.modelDigest]).toEqual(['org-a', 'ev1', 'd1'])
    expect(r.summary.total).toBe(GOLDEN_CASES.length)
    expect(r.summary.baseline.total).toBe(GOLDEN_CASES.length)
    expect(r.summary.hardGates).toBeGreaterThan(0)
    expect(r.results).toHaveLength(GOLDEN_CASES.length)
  })

  it('refuses if the saved model changed since the run was requested; skips non-running runs', async () => {
    evalRepo.getEvaluation.mockResolvedValue({ ...RUN, status: 'running' })
    aiRepo.loadAiModel.mockResolvedValue({ ...SAVED, model: 'llama3.2:1b' })
    expect(await processEvaluateModel({ organizationId: 'org-a', evaluationId: 'ev1' }, { makeClient: () => client() as never })).toEqual({ status: 'failed' })
    expect(evalRepo.failEvaluation).toHaveBeenCalledWith('org-a', 'ev1', 'MODEL_CHANGED_BEFORE_RUN')
    evalRepo.getEvaluation.mockResolvedValue({ ...RUN, status: 'completed' })
    expect(await processEvaluateModel({ organizationId: 'org-a', evaluationId: 'ev1' })).toEqual({ status: 'skipped_not_running' })
  })

  it('model unreachable at the start → run marked failed with the code (job does not throw)', async () => {
    evalRepo.getEvaluation.mockResolvedValue({ ...RUN, status: 'running' })
    aiRepo.loadAiModel.mockResolvedValue(SAVED)
    const down = client({ modelDigest: vi.fn(async () => { throw new ModelError('ollama', 'MODEL_UNREACHABLE', 0, {}, 'x') }) })
    expect(await processEvaluateModel({ organizationId: 'org-a', evaluationId: 'ev1' }, { makeClient: () => down as never })).toEqual({ status: 'failed' })
    expect(evalRepo.failEvaluation).toHaveBeenCalledWith('org-a', 'ev1', 'MODEL_UNREACHABLE')
  })
})
