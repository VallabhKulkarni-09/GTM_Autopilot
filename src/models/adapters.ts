/**
 * adapters.ts — the two model adapters.
 *   OpenAI-compatible: Ollama (/v1), OpenAI, OpenRouter, Google Gemini, LM Studio, vLLM.
 *   Anthropic: native Messages API.
 * Temperature is always 0. Neither adapter interprets the reply — callers schema-validate it.
 */
import { requestJson, type HttpOptions } from './http.js'
import { ModelError, isLocalProvider, type ChatRequest, type ChatResult, type ModelClient, type ModelConfig } from './types.js'

export const ANTHROPIC_VERSION = '2023-06-01'

type AdapterDeps = Pick<HttpOptions, 'resolver' | 'fetchImpl' | 'retryDelayMs'> & { timeoutMs: number }

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Ollama is configured by its root URL (http://host:11434); its OpenAI API lives under /v1. */
function openAiBase(cfg: ModelConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  return cfg.provider === 'ollama' && !base.endsWith('/v1') ? `${base}/v1` : base
}

export class OpenAiCompatibleClient implements ModelClient {
  readonly provider
  readonly model
  private readonly http: HttpOptions
  constructor(private readonly cfg: ModelConfig, deps: AdapterDeps) {
    this.provider = cfg.provider
    this.model = cfg.model
    this.http = { provider: cfg.provider, checkUrl: isLocalProvider(cfg.provider), ...deps }
  }

  private headers(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const start = Date.now()
    const body = obj(await requestJson(this.http, `${openAiBase(this.cfg)}/chat/completions`, {
      method: 'POST', headers: this.headers(),
      body: {
        model: this.cfg.model,
        temperature: 0,
        max_tokens: req.maxTokens,
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      },
    }))
    const choice = obj(Array.isArray(body.choices) ? body.choices[0] : undefined)
    const content = obj(choice.message).content
    if (typeof content !== 'string') throw new ModelError(this.provider, 'MODEL_BAD_RESPONSE', 200, body, 'The model reply had no text')
    return {
      text: content, provider: this.provider, temperature: 0, latencyMs: Date.now() - start,
      model: typeof body.model === 'string' ? body.model : this.cfg.model,
    }
  }

  async listModels(): Promise<string[]> {
    const body = obj(await requestJson(this.http, `${openAiBase(this.cfg)}/models`, { method: 'GET', headers: this.headers() }))
    if (!Array.isArray(body.data)) throw new ModelError(this.provider, 'MODEL_BAD_RESPONSE', 200, body, 'The model list had an unexpected format')
    const ids = body.data.map(m => obj(m).id).filter((id): id is string => typeof id === 'string')
    // Google lists "models/gemini-2.5-flash" but chat calls take "gemini-2.5-flash".
    return ids.map(id => (this.provider === 'gemini' ? id.replace(/^models\//, '') : id)).sort()
  }

  async modelDigest(): Promise<string | null> {
    if (this.provider !== 'ollama') return null
    const root = this.cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
    const body = obj(await requestJson(this.http, `${root}/api/tags`, { method: 'GET', headers: {} }))
    const models = Array.isArray(body.models) ? body.models.map(obj) : []
    const want = this.cfg.model.includes(':') ? this.cfg.model : `${this.cfg.model}:latest`
    const hit = models.find(m => m.name === want || m.model === want)
    return typeof hit?.digest === 'string' ? hit.digest : null
  }
}

export class AnthropicClient implements ModelClient {
  readonly provider = 'anthropic' as const
  readonly model
  private readonly http: HttpOptions
  constructor(private readonly cfg: ModelConfig, deps: AdapterDeps) {
    if (!cfg.apiKey) throw new ModelError('anthropic', 'MODEL_AUTH_FAILED', 0, { reason: 'no api key' }, 'An Anthropic API key is required')
    this.model = cfg.model
    this.http = { provider: 'anthropic', checkUrl: false, ...deps }
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.cfg.apiKey as string, 'anthropic-version': ANTHROPIC_VERSION }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const start = Date.now()
    const body = obj(await requestJson(this.http, `${this.cfg.baseUrl}/messages`, {
      method: 'POST', headers: this.headers(),
      body: {
        model: this.cfg.model, max_tokens: req.maxTokens, temperature: 0,
        system: req.json ? `${req.system}\n\nReply with a single JSON object and nothing else.` : req.system,
        messages: [{ role: 'user', content: req.user }],
      },
    }))
    const parts = Array.isArray(body.content) ? body.content.map(obj) : []
    const text = parts.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text as string).join('')
    if (!text) throw new ModelError('anthropic', 'MODEL_BAD_RESPONSE', 200, body, 'The model reply had no text')
    return {
      text, provider: 'anthropic', temperature: 0, latencyMs: Date.now() - start,
      model: typeof body.model === 'string' ? body.model : this.cfg.model,
    }
  }

  async listModels(): Promise<string[]> {
    const body = obj(await requestJson(this.http, `${this.cfg.baseUrl}/models?limit=1000`, { method: 'GET', headers: this.headers() }))
    if (!Array.isArray(body.data)) throw new ModelError('anthropic', 'MODEL_BAD_RESPONSE', 200, body, 'The model list had an unexpected format')
    return body.data.map(m => obj(m).id).filter((id): id is string => typeof id === 'string').sort()
  }

  async modelDigest(): Promise<string | null> { return null }
}
