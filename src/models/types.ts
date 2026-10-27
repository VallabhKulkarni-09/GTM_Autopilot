/**
 * types.ts — model layer. Two adapters only: OpenAI-compatible + Anthropic native.
 * Adapters throw only ModelError (same shape as ConnectorError, own `source`).
 */

export const MODEL_PROVIDERS = ['ollama', 'openai_compatible', 'openai', 'openrouter', 'anthropic', 'gemini'] as const
export type ModelProvider = typeof MODEL_PROVIDERS[number]

/**
 * Local = runs where the user chooses (base URL set by an admin). For 'openai_compatible' this is only
 * true when the address is on this machine / Docker / the private network — a public address is
 * treated like a cloud provider (consent required); see url-guard.ts `isPrivateAddress`.
 */
export const LOCAL_PROVIDERS: readonly ModelProvider[] = ['ollama', 'openai_compatible']
export const isLocalProvider = (p: ModelProvider) => LOCAL_PROVIDERS.includes(p)

/** Cloud base URLs are fixed in code — never user-supplied. */
export const CLOUD_BASE_URLS: Record<Exclude<ModelProvider, 'ollama' | 'openai_compatible'>, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  // Google's OpenAI-compatible Gemini endpoint (same adapter as OpenAI). Keys from aistudio.google.com.
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
}

export type ModelConfig = {
  provider: ModelProvider
  baseUrl: string          // local: admin-set (validated); cloud: CLOUD_BASE_URLS
  model: string
  apiKey: string | null    // null = keyless local server
}

export type ChatRequest = {
  system: string
  user: string             // untrusted lead data goes here, as data — never in `system`
  maxTokens: number
  json: boolean            // ask for a JSON object reply (validated by the caller)
}

export type ChatResult = {
  text: string
  provider: ModelProvider
  model: string            // model name the server reports (may differ from requested alias)
  temperature: 0
  latencyMs: number
}

export type ModelErrorCode =
  | 'MODEL_URL_BLOCKED'      // base URL failed the SSRF check
  | 'MODEL_UNREACHABLE'      // DNS / connection refused / TLS
  | 'MODEL_TIMEOUT'
  | 'MODEL_AUTH_FAILED'      // 401/403
  | 'MODEL_NOT_FOUND'        // 404 (unknown model or wrong base URL)
  | 'MODEL_RATE_LIMITED'     // 429 (temporary)
  | 'MODEL_QUOTA_EXCEEDED'   // 429 with insufficient_quota / no credits (will not fix itself)
  | 'MODEL_BAD_REQUEST'      // other 4xx
  | 'MODEL_SERVER_ERROR'     // 5xx
  | 'MODEL_BAD_RESPONSE'     // 2xx with an unexpected body
  | 'MODEL_BUSY'             // concurrency queue full

export class ModelError extends Error {
  constructor(
    readonly source: ModelProvider,
    readonly code: ModelErrorCode,
    readonly statusCode: number,     // HTTP status, 0 when no response
    readonly raw: unknown,           // response body or error detail — never undefined
    message: string,
  ) {
    super(message)
    this.name = 'ModelError'
  }
}

export interface ModelClient {
  readonly provider: ModelProvider
  readonly model: string
  chat(req: ChatRequest): Promise<ChatResult>
  listModels(): Promise<string[]>
  /** Exact weights fingerprint when the server exposes one (Ollama), else null. Recorded in snapshots. */
  modelDigest(): Promise<string | null>
}
