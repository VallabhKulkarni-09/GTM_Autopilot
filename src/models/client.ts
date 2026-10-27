/**
 * client.ts — builds a ModelClient from a stored config and wraps chat() in a process-wide
 * concurrency limit, so a burst of leads cannot overload a laptop's Ollama.
 *
 * Settings (env, read once): MODEL_TIMEOUT_MS (default 30000), MODEL_MAX_CONCURRENCY (default 2),
 * MODEL_MAX_QUEUE (default 100). Invalid values throw at first use rather than being ignored.
 */
import { AnthropicClient, OpenAiCompatibleClient } from './adapters.js'
import { ModelError, type ModelClient, type ModelConfig } from './types.js'
import type { Resolver } from './url-guard.js'

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${raw}")`)
  return n
}

export class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []
  constructor(readonly max: number, readonly maxQueue: number) {}

  async run<T>(fn: () => Promise<T>, onFull: () => Error): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.maxQueue) throw onFull()
      await new Promise<void>(resolve => this.waiting.push(resolve))
    } else {
      this.active++
    }
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next()          // hand the slot over directly
      else this.active--
    }
  }
}

let limiter: Semaphore | null = null
function getLimiter(): Semaphore {
  limiter ??= new Semaphore(envInt('MODEL_MAX_CONCURRENCY', 2, 1, 64), envInt('MODEL_MAX_QUEUE', 100, 0, 10_000))
  return limiter
}

export type ClientDeps = { timeoutMs?: number; resolver?: Resolver; fetchImpl?: typeof fetch; retryDelayMs?: number; limiter?: Semaphore }

export function createModelClient(cfg: ModelConfig, deps: ClientDeps = {}): ModelClient {
  const timeoutMs = deps.timeoutMs ?? envInt('MODEL_TIMEOUT_MS', 30_000, 1000, 600_000)
  const adapterDeps = { timeoutMs, resolver: deps.resolver, fetchImpl: deps.fetchImpl, retryDelayMs: deps.retryDelayMs }
  const inner: ModelClient = cfg.provider === 'anthropic'
    ? new AnthropicClient(cfg, adapterDeps)
    : new OpenAiCompatibleClient(cfg, adapterDeps)
  const sem = deps.limiter ?? getLimiter()
  return {
    provider: inner.provider,
    model: inner.model,
    chat: req => sem.run(() => inner.chat(req),
      () => new ModelError(inner.provider, 'MODEL_BUSY', 0, { maxQueue: sem.maxQueue }, 'Too many leads are waiting for the model')),
    listModels: () => inner.listModels(),
    modelDigest: () => inner.modelDigest(),
  }
}
