/**
 * base.ts
 * Base connector interface, ConnectorError class, and shared types.
 * Every connector must implement Connector<TConfig>.
 */

import type { ConnectorName } from '../domain/db-types.js'

export type { ConnectorName }

// ─── Connector Health ─────────────────────────────────────────────────────────

export type ConnectorHealth = {
  ok: boolean
  latencyMs: number
  lastChecked: Date
  error?: string
}

// ─── Connector Interface ───────────────────────────────────────────────────────

export interface Connector<TConfig> {
  readonly name: ConnectorName
  readonly version: string
  connect(config: TConfig): Promise<void>
  healthCheck(): Promise<ConnectorHealth>
  disconnect(): Promise<void>
}

// ─── ConnectorError ───────────────────────────────────────────────────────────

/**
 * The only error type allowed to escape from any connector.
 * Never throw raw Error from a connector.
 */
export class ConnectorError extends Error {
  constructor(
    public readonly source: ConnectorName,
    public readonly code: string,             // SCREAMING_SNAKE_CASE
    public readonly statusCode: number,       // HTTP status from external system
    public readonly raw: unknown,             // full response body — never undefined
    message: string
  ) {
    super(message)
    this.name = 'ConnectorError'
  }
}

// ─── Retry Policy ─────────────────────────────────────────────────────────────

export const RETRY_CONFIG = {
  maxAttempts: 3,
  backoff: [1000, 2000, 4000] as const,  // ms, exponential
  retryOn: [429, 503] as const,
  noRetryOn: [400, 401, 403, 404] as const,
} as const

/**
 * Executes fn with retry logic per RETRY_CONFIG.
 * Retries on 429/503 and network errors.
 * Never retries on 400/401/403/404.
 */
export async function withRetry<T>(
  source: ConnectorName,
  operationCode: string,
  fn: () => Promise<T>
): Promise<T> {
  let lastError: ConnectorError | undefined

  for (let attempt = 0; attempt < RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      // AbortError / TimeoutError — thrown by AbortSignal.timeout(); never retry
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new ConnectorError(
          source,
          'TIMEOUT',
          408,
          { message: `Request timed out after 8s` },
          `Request timed out after 8s`
        )
      }

      if (err instanceof ConnectorError) {
        if ((RETRY_CONFIG.noRetryOn as readonly number[]).includes(err.statusCode)) {
          throw err
        }
        lastError = err
      } else {
        // Network/unknown errors — wrap and retry
        lastError = new ConnectorError(
          source,
          operationCode,
          0,
          err,
          err instanceof Error ? err.message : String(err)
        )
      }

      if (attempt < RETRY_CONFIG.maxAttempts - 1) {
        await sleep(RETRY_CONFIG.backoff[attempt])
      }
    }
  }

  throw lastError!
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
