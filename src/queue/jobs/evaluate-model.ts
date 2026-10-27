/**
 * evaluate-model.ts — 'evaluate-model' job: run the golden set against the workspace's saved model.
 * Never throws for model problems (they are recorded on the run as 'failed'), so BullMQ does not
 * repeat a multi-minute run. The run is refused if the saved model changed since it was requested.
 */
import { createModelClient } from '../../models/client.js'
import type { ModelClient, ModelConfig } from '../../models/types.js'
import { CLOUD_BASE_URLS, isLocalProvider } from '../../models/types.js'
import { evaluateQualificationModel } from '../../evaluation/evaluate-model.js'
import { loadAiModel } from '../../repositories/ai-model.repository.js'
import {
  completeEvaluation, failEvaluation, getEvaluation, updateEvaluationProgress,
} from '../../repositories/ai-model-evaluation.repository.js'

export type EvaluateModelJob = { organizationId: string; evaluationId: string }

export type EvaluateModelDeps = { makeClient: (cfg: ModelConfig) => ModelClient }
const defaultDeps: EvaluateModelDeps = { makeClient: cfg => createModelClient(cfg) }

export async function processEvaluateModel(job: EvaluateModelJob, deps: EvaluateModelDeps = defaultDeps): Promise<{ status: string }> {
  const { organizationId, evaluationId } = job
  const run = await getEvaluation(organizationId, evaluationId)
  if (!run || run.status !== 'running') return { status: 'skipped_not_running' }

  try {
    const saved = await loadAiModel(organizationId)
    if (!saved || saved.provider !== run.provider || saved.model !== run.model) {
      await failEvaluation(organizationId, evaluationId, 'MODEL_CHANGED_BEFORE_RUN')
      return { status: 'failed' }
    }
    const baseUrl = isLocalProvider(saved.provider)
      ? saved.base_url as string
      : CLOUD_BASE_URLS[saved.provider as keyof typeof CLOUD_BASE_URLS]
    const client = deps.makeClient({ provider: saved.provider, baseUrl, model: saved.model, apiKey: saved.apiKey })
    let lastWrite = 0
    const result = await evaluateQualificationModel(client, {
      onProgress: async (done, total) => {
        if (Date.now() - lastWrite < 2000 && done < total) return
        lastWrite = Date.now()
        await updateEvaluationProgress(organizationId, evaluationId, done, total)
      },
    })
    if (result.summary.errors === result.summary.total) {
      await failEvaluation(organizationId, evaluationId, 'EVERY_CASE_FAILED')
      return { status: 'failed' }
    }
    await completeEvaluation(organizationId, evaluationId, { modelDigest: result.modelDigest, summary: result.summary, results: result.results, routingResults: result.routingResults })
    return { status: 'completed' }
  } catch (e) {
    const code = (e as { code?: string }).code
    await failEvaluation(organizationId, evaluationId, code ?? (e instanceof Error ? e.message : 'UNKNOWN_ERROR'))
    return { status: 'failed' }
  }
}
