/**
 * qualification-model.ts — decides, per lead, whether an AI agent (qualification or routing) may run.
 *
 *   off       no model saved, or that agent's switch is off → v1 rules, no event (normal operation)
 *   fallback  switched on, but the gate no longer holds or the model is unreachable → v1 rules
 *             + a `model_fallback` event (never silent)
 *   on        model client + the digest that passed the golden set
 */
import { createModelClient } from '../../models/client.js'
import { CLOUD_BASE_URLS, ModelError, isLocalProvider, type ModelClient, type ModelConfig, type ModelProvider } from '../../models/types.js'
import { QUALIFICATION_V2_VERSION } from '../../agents/qualification/llm.js'
import { PROMPT_VERSION } from '../../agents/qualification/prompt.js'
import { ROUTING_PROMPT_VERSION, ROUTING_V2_VERSION } from '../../agents/routing/llm.js'
import { loadAiModel } from '../../repositories/ai-model.repository.js'
import { getEvaluation, type EvaluationRow } from '../../repositories/ai-model-evaluation.repository.js'

export type AiAgentKind = 'qualification' | 'routing'

export type QualificationModelChoice =
  | { kind: 'off' }
  | { kind: 'fallback'; reason: string; provider: ModelProvider; model: string; evaluationId: string | null }
  | { kind: 'on'; client: ModelClient; modelDigest: string | null; evaluatedDigest: string | null; evaluationId: string }

export type ChoiceDeps = {
  load: typeof loadAiModel
  getRun: typeof getEvaluation
  makeClient: (cfg: ModelConfig) => ModelClient
}
const defaultDeps: ChoiceDeps = { load: loadAiModel, getRun: getEvaluation, makeClient: cfg => createModelClient(cfg) }

/** True when the run tested the versions this build would use for that agent. */
export function runCurrentFor(agent: AiAgentKind, run: Pick<EvaluationRow, 'prompt_version' | 'agent_version' | 'routing_prompt_version' | 'routing_agent_version'>): boolean {
  return agent === 'qualification'
    ? run.prompt_version === PROMPT_VERSION && run.agent_version === QUALIFICATION_V2_VERSION
    : run.routing_prompt_version === ROUTING_PROMPT_VERSION && run.routing_agent_version === ROUTING_V2_VERSION
}

export async function chooseAgentModel(organizationId: string, agent: AiAgentKind, deps: ChoiceDeps = defaultDeps): Promise<QualificationModelChoice> {
  const saved = await deps.load(organizationId)
  const enabled = agent === 'qualification' ? saved?.qualification_agent_enabled : saved?.routing_agent_enabled
  if (!saved || !enabled) return { kind: 'off' }
  const evaluationId = agent === 'qualification' ? saved.qualification_evaluation_id : saved.routing_evaluation_id
  const who = { provider: saved.provider, model: saved.model, evaluationId }

  const run = evaluationId ? await deps.getRun(organizationId, evaluationId) : null
  if (!run || run.status !== 'completed' || run.provider !== saved.provider || run.model !== saved.model) {
    return { kind: 'fallback', reason: 'MODEL_EVALUATION_MISSING', ...who }
  }
  if (!runCurrentFor(agent, run)) return { kind: 'fallback', reason: 'MODEL_EVALUATION_OUTDATED', ...who }

  const baseUrl = isLocalProvider(saved.provider) ? saved.base_url as string : CLOUD_BASE_URLS[saved.provider as keyof typeof CLOUD_BASE_URLS]
  const client = deps.makeClient({ provider: saved.provider, baseUrl, model: saved.model, apiKey: saved.apiKey })
  let modelDigest: string | null
  try {
    modelDigest = await client.modelDigest()
  } catch (e) {
    if (e instanceof ModelError) return { kind: 'fallback', reason: e.code, ...who }
    throw e
  }
  return { kind: 'on', client, modelDigest, evaluatedDigest: run.model_digest, evaluationId: run.id }
}

export const chooseQualificationModel = (organizationId: string, deps: ChoiceDeps = defaultDeps) =>
  chooseAgentModel(organizationId, 'qualification', deps)
export const chooseRoutingModel = (organizationId: string, deps: ChoiceDeps = defaultDeps) =>
  chooseAgentModel(organizationId, 'routing', deps)
