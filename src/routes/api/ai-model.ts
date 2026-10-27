/**
 * ai-model.ts — Settings → AI model. All writes are admin-only (ADMIN_WRITE_PREFIXES).
 *
 *   GET    /api/ai-model           → current connection (never the key)
 *   POST   /api/ai-model/models    → list the models a server offers (for the dropdown)
 *   POST   /api/ai-model/test      → live check: one tiny chat call; nothing stored
 *   PUT    /api/ai-model           → test, then save. consent: true is required whenever lead data leaves the
 *                                     user's network: every cloud provider, and a local-type server whose
 *                                     address is public (e.g. Google's endpoint typed into "Other server")
 *   DELETE /api/ai-model           → disconnect
 *   POST   /api/ai-model/evaluations         → run the test leads (golden set) against the saved model (job)
 *   GET    /api/ai-model/evaluations/latest  → progress / result of the latest run
 *   PUT    /api/ai-model/agents       { qualification?, routing? } → switch each AI agent on/off;
 *                                     on requires a completed run for the current model + prompt + agent version
 *
 * A blank apiKey reuses the saved key, but only for the same provider.
 * Local base URLs pass the SSRF guard; cloud base URLs are fixed in code.
 * Saving a different provider/model/address switches the agent off (it must be re-tested).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createModelClient } from '../../models/client.js'
import { checkBaseUrl, UrlBlockedError, type Resolver } from '../../models/url-guard.js'
import {
  CLOUD_BASE_URLS, MODEL_PROVIDERS, ModelError, isLocalProvider,
  type ModelClient, type ModelConfig, type ModelErrorCode, type ModelProvider,
} from '../../models/types.js'
import { deleteAiModel, describeAiModel, loadAiModel, saveAiModel, type AiModelRow } from '../../repositories/ai-model.repository.js'
import {
  createEvaluation, getLatestEvaluation, setQualificationAgent, setRoutingAgent, type EvaluationRow,
} from '../../repositories/ai-model-evaluation.repository.js'
import { PROMPT_VERSION } from '../../agents/qualification/prompt.js'
import { QUALIFICATION_V2_VERSION } from '../../agents/qualification/llm.js'
import { GOLDEN_DATASET_VERSION } from '../../evaluation/datasets/golden.js'
import { ROUTING_PROMPT_VERSION, ROUTING_V2_VERSION } from '../../agents/routing/llm.js'
import { runCurrentFor, type AiAgentKind } from '../../workflows/inbound-lead/qualification-model.js'

type Body = { provider: ModelProvider; baseUrl?: string; model?: string; apiKey?: string; consent?: boolean }

const MESSAGES: Record<ModelErrorCode | 'CONNECTION_FAILED', { title: string; fix: string }> = {
  MODEL_URL_BLOCKED:  { title: 'This address is not allowed.', fix: 'Use the address of your own model server, for example http://ollama.internal:11434.' },
  MODEL_UNREACHABLE:  { title: 'Could not reach the model server.', fix: 'Check the address and that the server is running. For Ollama on this computer, run: docker compose --profile ollama up -d (see docs/ai-models.md).' },
  MODEL_TIMEOUT:      { title: 'The model took too long to answer.', fix: 'Try a smaller model, or check the server is not busy.' },
  MODEL_AUTH_FAILED:  { title: 'The API key was not accepted.', fix: 'Paste a new key from your provider account.' },
  MODEL_NOT_FOUND:    { title: 'The model or address was not found.', fix: 'Check the model name (for Ollama, run "ollama list").' },
  MODEL_RATE_LIMITED: { title: 'The provider is limiting requests.', fix: 'Wait a minute and try again, or check your plan limits.' },
  MODEL_QUOTA_EXCEEDED: { title: 'The provider account has no credits left.', fix: 'Add credits or a payment method in your provider account (for OpenAI: platform.openai.com › Settings › Billing), then test again.' },
  MODEL_BAD_REQUEST:  { title: 'The provider refused the request.', fix: 'Check the model name is one this provider offers.' },
  MODEL_SERVER_ERROR: { title: 'The model server had an error.', fix: 'Try again in a moment.' },
  MODEL_BAD_RESPONSE: { title: 'The server answered, but not like a model server.', fix: 'Check the address points to the model API.' },
  MODEL_BUSY:         { title: 'The model is busy with other leads.', fix: 'Try again in a moment.' },
  CONNECTION_FAILED:  { title: 'Could not connect.', fix: 'Check the details and try again.' },
}

const PING_SYSTEM = 'You are a connection check. Reply with exactly this JSON object: {"ok": true}'

export type AiModelDeps = {
  makeClient: (cfg: ModelConfig) => ModelClient
  resolver?: Resolver
  enqueueEvaluation?: (organizationId: string, evaluationId: string) => Promise<void>
}
// Lazy import: loading this route must not open a Redis connection (tests, API-only processes).
const enqueueEvaluation = async (organizationId: string, evaluationId: string) => {
  const { addJob } = await import('../../queue/setup.js')
  await addJob('evaluate-model', { organizationId, evaluationId }, { jobId: `eval-${evaluationId}`, attempts: 1 })
}
const defaultDeps: AiModelDeps = { makeClient: cfg => createModelClient(cfg), enqueueEvaluation }

/** True when a completed run tested exactly what the workspace would use now. */
export function runMatches(run: EvaluationRow | null, row: AiModelRow | null, agent: AiAgentKind = 'qualification'): boolean {
  return Boolean(run && row && run.status === 'completed' && run.provider === row.provider && run.model === row.model
    && runCurrentFor(agent, run))
}

function evaluationDto(run: EvaluationRow) {
  return {
    id: run.id, status: run.status, provider: run.provider, model: run.model, modelDigest: run.model_digest,
    promptVersion: run.prompt_version, agentVersion: run.agent_version, datasetVersion: run.dataset_version,
    summary: run.summary, error: run.error, startedAt: run.started_at, completedAt: run.completed_at,
    misses: (run.results ?? []).filter(r => !r.agrees).slice(0, 25).map(r => ({
      caseId: r.caseId, description: r.description, expected: r.expected, actual: r.actual,
      outcome: r.outcome, review: r.review, fallbackReason: r.fallbackReason,
    })),
    routingMisses: (run.routing_results ?? []).filter(r => !r.agrees).slice(0, 25).map(r => ({
      caseId: r.caseId, description: r.description, expected: r.expected, actual: r.actual,
      outcome: r.outcome, countryRaw: r.countryRaw, countryCode: r.countryCode, fallbackReason: r.fallbackReason,
    })),
  }
}

class InputError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

const bodySchema = (requireModel: boolean) => ({
  type: 'object',
  required: requireModel ? ['provider', 'model'] : ['provider'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', enum: [...MODEL_PROVIDERS] },
    baseUrl: { type: 'string', maxLength: 500 },
    model: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f]+$' },
    apiKey: { type: 'string', maxLength: 500 },
    consent: { type: 'boolean' },
  },
})

export function createAiModelRoutes(deps: AiModelDeps = defaultDeps) {
  /** Body + saved row → a full config. Throws InputError for anything missing or not allowed. */
  async function resolveConfig(orgId: string, body: Body, model: string): Promise<ModelConfig & { leavesNetwork: boolean }> {
    const { provider } = body
    let baseUrl: string
    let leavesNetwork = true
    if (isLocalProvider(provider)) {
      if (!body.baseUrl?.trim()) throw new InputError('MISSING_FIELDS', 'Please fill in: Server address.')
      try {
        const checked = await checkBaseUrl(body.baseUrl, deps.resolver)
        baseUrl = checked.url.toString().replace(/\/+$/, '')
        leavesNetwork = !checked.privateOnly
      } catch (e) {
        if (e instanceof UrlBlockedError) throw new InputError('MODEL_URL_BLOCKED', e.message)
        throw e
      }
    } else {
      baseUrl = CLOUD_BASE_URLS[provider as keyof typeof CLOUD_BASE_URLS]
    }
    let apiKey = body.apiKey?.trim() || null
    if (!apiKey) {
      const saved = await loadAiModel(orgId)
      if (saved?.provider === provider) apiKey = saved.apiKey
    }
    if (!isLocalProvider(provider) && !apiKey) throw new InputError('MISSING_FIELDS', 'Please fill in: API key.')
    if (provider === 'ollama') apiKey = null
    return { provider, baseUrl, model, apiKey, leavesNetwork }
  }

  function fail(reply: FastifyReply, request: FastifyRequest, e: unknown) {
    if (e instanceof InputError) return reply.status(400).send({ error: e.code, message: e.message, requestId: request.id })
    if (!(e instanceof ModelError)) throw e   // unexpected → 500 via Fastify, no details leaked
    request.log.info({ code: e.code, status: e.statusCode }, 'ai model check failed')
    const m = MESSAGES[e.code]
    return reply.send({ ok: false, error: e.code, message: m.title, fix: m.fix })
  }

  async function liveCheck(cfg: ModelConfig) {
    const client = deps.makeClient(cfg)
    const res = await client.chat({ system: PING_SYSTEM, user: 'ping', maxTokens: 20, json: true })
    let jsonOk = false
    try { jsonOk = (JSON.parse(res.text) as { ok?: unknown })?.ok === true } catch { /* reported below */ }
    const digest = await client.modelDigest().catch(() => null)
    return { latencyMs: res.latencyMs, reportedModel: res.model, digest, jsonOk }
  }

  return async function aiModelRoutes(app: FastifyInstance) {
    app.get('/', async request => {
      const row = await describeAiModel(request.tenantContext.organizationId)
      return {
        configured: row !== null,
        provider: row?.provider ?? null,
        baseUrl: row?.base_url ?? null,
        model: row?.model ?? null,
        hasApiKey: row?.has_api_key ?? false,
        qualificationAgentEnabled: row?.qualification_agent_enabled ?? false,
        // Consent is recorded exactly when data leaves the network (cloud, or a public "local-type" address).
        dataLeavesMachine: row ? !isLocalProvider(row.provider) || row.data_consent_at !== null : false,
        consentAt: row?.data_consent_at ?? null,
        lastTest: row?.last_test_at ? { ok: row.last_test_ok === true, at: row.last_test_at } : null,
        suggestedOllamaUrl: process.env.OLLAMA_BASE_URL?.trim() || null,
      }
    })

    app.post<{ Body: Body }>('/models', { schema: { body: bodySchema(false) } }, async (request, reply) => {
      try {
        const { leavesNetwork: _, ...cfg } = await resolveConfig(request.tenantContext.organizationId, request.body, '-')
        return { ok: true, models: await deps.makeClient(cfg).listModels() }
      } catch (e) { return fail(reply, request, e) }
    })

    app.post<{ Body: Body }>('/test', { schema: { body: bodySchema(true) } }, async (request, reply) => {
      try {
        // A ping only ("ping" → {"ok": true}); no lead data, so no consent needed to test.
        const { leavesNetwork, ...cfg } = await resolveConfig(request.tenantContext.organizationId, request.body, request.body.model as string)
        return { ok: true, leavesNetwork, ...(await liveCheck(cfg)) }
      } catch (e) { return fail(reply, request, e) }
    })

    app.put<{ Body: Body }>('/', { schema: { body: bodySchema(true) } }, async (request, reply) => {
      const { organizationId, userId } = request.tenantContext
      const { provider } = request.body
      const consentRequired = () => reply.status(400).send({
        error: 'CONSENT_REQUIRED',
        message: isLocalProvider(provider)
          ? 'This server address is on the internet, not your own network. Confirm that lead details will be sent to it before saving.'
          : 'Confirm that lead details will be sent to this provider before saving.',
        requestId: request.id,
      })
      // Cloud: refuse before any network call. Local types: known only after the address is resolved.
      if (!isLocalProvider(provider) && request.body.consent !== true) return consentRequired()
      try {
        const { leavesNetwork, ...cfg } = await resolveConfig(organizationId, request.body, request.body.model as string)
        if (leavesNetwork && request.body.consent !== true) return consentRequired()
        const check = await liveCheck(cfg)
        const before = await describeAiModel(organizationId)
        const baseUrl = isLocalProvider(provider) ? cfg.baseUrl : null
        const resetAgents = !before || before.provider !== provider || before.model !== cfg.model || before.base_url !== baseUrl
        await saveAiModel(organizationId, {
          provider, baseUrl, model: cfg.model, apiKey: cfg.apiKey,
          consentBy: leavesNetwork ? userId : null, testOk: true, resetAgents,
        })
        return { ok: true, saved: true, agentsTurnedOff: resetAgents && Boolean(before?.qualification_agent_enabled || before?.routing_agent_enabled), ...check }
      } catch (e) { return fail(reply, request, e) }
    })

    app.post('/evaluations', async (request, reply) => {
      const { organizationId, userId } = request.tenantContext
      const row = await describeAiModel(organizationId)
      if (!row) return reply.status(404).send({ error: 'AI_MODEL_NOT_SET', message: 'Save an AI model first.', requestId: request.id })
      const run = await createEvaluation(organizationId, {
        provider: row.provider, model: row.model, prompt_version: PROMPT_VERSION,
        agent_version: QUALIFICATION_V2_VERSION, dataset_version: GOLDEN_DATASET_VERSION, requested_by: userId,
        routing_prompt_version: ROUTING_PROMPT_VERSION, routing_agent_version: ROUTING_V2_VERSION,
      })
      if (!run) return reply.status(409).send({ error: 'EVALUATION_RUNNING', message: 'The test leads are already running.', requestId: request.id })
      await (deps.enqueueEvaluation ?? enqueueEvaluation)(organizationId, run.id)
      return reply.status(202).send({ evaluation: evaluationDto(run) })
    })

    app.get('/evaluations/latest', async request => {
      const { organizationId } = request.tenantContext
      const [run, row] = await Promise.all([getLatestEvaluation(organizationId), describeAiModel(organizationId)])
      return {
        evaluation: run ? evaluationDto(run) : null,
        matchesCurrentModel: runMatches(run, row),
        routingMatchesCurrentModel: runMatches(run, row, 'routing'),
        qualificationAgentEnabled: row?.qualification_agent_enabled ?? false,
        routingAgentEnabled: row?.routing_agent_enabled ?? false,
      }
    })

    app.put<{ Body: { qualification?: boolean; routing?: boolean } }>('/agents', {
      schema: { body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { qualification: { type: 'boolean' }, routing: { type: 'boolean' } },
      } },
    }, async (request, reply) => {
      const { organizationId } = request.tenantContext
      const row = await describeAiModel(organizationId)
      if (!row) return reply.status(404).send({ error: 'AI_MODEL_NOT_SET', message: 'Save an AI model first.', requestId: request.id })
      const run = await getLatestEvaluation(organizationId)
      const wanted = (['qualification', 'routing'] as const).filter(a => request.body[a] !== undefined)
      // Check every "on" first, so a refused request changes nothing.
      for (const agent of wanted) {
        if (request.body[agent] && !runMatches(run, row, agent)) {
          return reply.status(409).send({
            error: 'EVALUATION_REQUIRED',
            message: 'Run the test leads with this model first. Changing the model or updating the app needs a new run.',
            requestId: request.id,
          })
        }
      }
      for (const agent of wanted) {
        const on = request.body[agent] === true
        await (agent === 'qualification' ? setQualificationAgent : setRoutingAgent)(organizationId, on, on ? (run as EvaluationRow).id : null)
      }
      const after = await describeAiModel(organizationId)
      return {
        qualificationAgentEnabled: after?.qualification_agent_enabled ?? false,
        routingAgentEnabled: after?.routing_agent_enabled ?? false,
        ...(wanted.some(a => request.body[a]) ? { evaluationId: (run as EvaluationRow).id } : {}),
      }
    })

    app.delete('/', async (request, reply) => {
      await deleteAiModel(request.tenantContext.organizationId)
      return reply.status(204).send()
    })
  }
}

export const aiModelRoutes = createAiModelRoutes()
