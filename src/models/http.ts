/**
 * http.ts — the one fetch wrapper both adapters use.
 * Timeout via AbortSignal, redirects refused, local URLs re-checked against the SSRF guard,
 * up to 2 retries on 429/503 (honouring Retry-After / "retry in Ns", max 60 s), every failure mapped to a ModelError.
 */
import { ModelError, type ModelErrorCode, type ModelProvider } from './types.js'
import { assertBaseUrlAllowed, UrlBlockedError, type Resolver } from './url-guard.js'

export type HttpOptions = {
  provider: ModelProvider
  timeoutMs: number
  checkUrl: boolean          // true for admin-set (local) base URLs
  resolver?: Resolver
  fetchImpl?: typeof fetch
  retryDelayMs?: number
}

const RETRY_ON = new Set([429, 503])
const MAX_ATTEMPTS = 3

function codeFor(status: number): ModelErrorCode {
  if (status === 401 || status === 403) return 'MODEL_AUTH_FAILED'
  if (status === 404) return 'MODEL_NOT_FOUND'
  if (status === 429) return 'MODEL_RATE_LIMITED'
  if (status >= 500) return 'MODEL_SERVER_ERROR'
  return 'MODEL_BAD_REQUEST'
}

/** Error object from either `{ error: … }` (OpenAI/Anthropic) or `[{ error: … }]` (Google). */
function errorOf(body: unknown): { code?: unknown; type?: unknown; status?: unknown; message?: unknown } | null {
  const b = Array.isArray(body) ? body[0] : body
  const e = (b as { error?: unknown } | null)?.error
  return typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : null
}

/**
 * 429 means either "slow down" (retry) or "no money left" (do not). Only explicit balance signals count as
 * the latter: Google's per-minute limit also says "exceeded your current quota", so that phrase is not used.
 */
function isQuotaError(body: unknown): boolean {
  const err = errorOf(body)
  return err?.code === 'insufficient_quota' || err?.type === 'insufficient_quota'
    || (typeof err?.message === 'string' && /no credits|insufficient (credits|balance)|credit balance is too low/i.test(err.message))
}

const MAX_RETRY_WAIT_MS = 60_000

/** How long the server asked us to wait: Retry-After header, or Google's "Please retry in 42.3s". */
export function retryAfterMs(res: Response, body: unknown): number | null {
  const h = res.headers.get('retry-after')
  if (h && /^\d+(\.\d+)?$/.test(h.trim())) return Math.ceil(Number(h) * 1000)
  // Google: "Please retry in 42.38s" or "retry in 17h34m7.48s" (daily limit).
  const m = /retry in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i.exec(String(errorOf(body)?.message ?? ''))
  if (!m) return null
  return Math.ceil(((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 1000)
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text.slice(0, 2000) }
}

export async function requestJson(
  opts: HttpOptions,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown },
): Promise<unknown> {
  const { provider } = opts
  if (opts.checkUrl) {
    try { await assertBaseUrlAllowed(url, opts.resolver) } catch (e) {
      if (e instanceof UrlBlockedError) throw new ModelError(provider, 'MODEL_URL_BLOCKED', 0, { url }, e.message)
      throw e
    }
  }
  const doFetch = opts.fetchImpl ?? fetch
  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await doFetch(url, {
        method: init.method,
        headers: { accept: 'application/json', ...init.headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
    } catch (e) {
      const err = e as Error
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ModelError(provider, 'MODEL_TIMEOUT', 0, { url, timeoutMs: opts.timeoutMs }, `The model did not answer within ${Math.round(opts.timeoutMs / 1000)} seconds`)
      }
      throw new ModelError(provider, 'MODEL_UNREACHABLE', 0, { url, cause: String((err as { cause?: unknown }).cause ?? err.message) }, 'Could not reach the model server')
    }
    if (res.ok) {
      const body = await readBody(res)
      if (typeof body !== 'object' || body === null) throw new ModelError(provider, 'MODEL_BAD_RESPONSE', res.status, body, 'The model server sent a reply that is not JSON')
      return body
    }
    const body = await readBody(res)
    if (res.status === 429 && isQuotaError(body)) {
      throw new ModelError(provider, 'MODEL_QUOTA_EXCEEDED', 429, body, 'The provider account has no credits left')
    }
    if (attempt < MAX_ATTEMPTS && RETRY_ON.has(res.status)) {
      const asked = retryAfterMs(res, body)
      if (asked === null || asked <= MAX_RETRY_WAIT_MS) {
        // Honour the server's wait (bounded); otherwise back off 1s, 2s. Test hook overrides both.
        await new Promise(r => setTimeout(r, opts.retryDelayMs ?? asked ?? 1000 * attempt))
        continue
      }
    }
    throw new ModelError(provider, codeFor(res.status), res.status, body, `The model server answered HTTP ${res.status}`)
  }
}
