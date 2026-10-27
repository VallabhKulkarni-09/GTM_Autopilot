/**
 * clearbit.connector.ts
 * Clearbit connector implementing Connector<ClearbitConfig>.
 * Credentials: CLEARBIT_API_KEY
 * CRITICAL: enrichByEmail and enrichByDomain return null on 404/not-found. Never throw on not-found.
 */

import { Connector, ConnectorError, ConnectorHealth, withRetry } from '../base.js'
import { ClearbitErrorCode } from './clearbit.errors.js'
import type { ClearbitConfig, ClearbitPerson, ClearbitCompany } from './clearbit.types.js'

const CB_PERSON_BASE  = 'https://person.clearbit.com/v2'
const CB_COMPANY_BASE = 'https://company.clearbit.com/v2'

export class ClearbitConnector implements Connector<ClearbitConfig> {
  readonly name = 'clearbit' as const
  readonly version = '1.0.0'
  private config: ClearbitConfig | null = null

  async connect(config: ClearbitConfig): Promise<void> { this.config = config }
  async disconnect(): Promise<void> { this.config = null }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now()
    try {
      // Lightweight check: attempt person lookup with a known-bad email — expect 404 (not 401/5xx)
      const res = await fetch(`${CB_PERSON_BASE}/people/find?email=healthcheck@clearbit-test-ping.invalid`, {
        headers: this.headers(),
      })
      const ok = res.status === 404 || res.status === 200 || res.status === 202
      return { ok, latencyMs: Date.now() - start, lastChecked: new Date(), error: ok ? undefined : `Status ${res.status}` }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, lastChecked: new Date(), error: String(err) }
    }
  }

  /**
   * Returns null when no person data exists for the email (404 or empty).
   * Only throws ConnectorError on actual API failures (5xx, auth, network).
   */
  async enrichByEmail(email: string): Promise<ClearbitPerson | null> {
    return withRetry(this.name, ClearbitErrorCode.ENRICH_EMAIL_FAILED, async () => {
      this.assertConnected()
      const res = await fetch(`${CB_PERSON_BASE}/people/find?email=${encodeURIComponent(email)}`, {
        headers: this.headers(),
      })

      // 404 = no data found — return null, do not throw
      if (res.status === 404) return null
      // 202 = Clearbit is looking it up asynchronously — treat as not-found for now
      if (res.status === 202) return null

      if (!res.ok) {
        const raw = await res.text()
        // 401/403 are auth errors — do not retry, throw immediately
        throw new ConnectorError(this.name, ClearbitErrorCode.ENRICH_EMAIL_FAILED, res.status, raw, `Clearbit person enrichment failed for ${email}`)
      }

      return res.json() as Promise<ClearbitPerson>
    })
  }

  /**
   * Returns null when no company data exists for the domain (404 or empty).
   * Only throws ConnectorError on actual API failures (5xx, auth, network).
   */
  async enrichByDomain(domain: string): Promise<ClearbitCompany | null> {
    return withRetry(this.name, ClearbitErrorCode.ENRICH_DOMAIN_FAILED, async () => {
      this.assertConnected()
      const res = await fetch(`${CB_COMPANY_BASE}/companies/find?domain=${encodeURIComponent(domain)}`, {
        headers: this.headers(),
      })

      // 404 = no data found — return null, do not throw
      if (res.status === 404) return null
      // 202 = async lookup in progress — return null
      if (res.status === 202) return null

      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, ClearbitErrorCode.ENRICH_DOMAIN_FAILED, res.status, raw, `Clearbit company enrichment failed for domain ${domain}`)
      }

      return res.json() as Promise<ClearbitCompany>
    })
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config!.apiKey}` }
  }
  private assertConnected(): void {
    if (!this.config) throw new ConnectorError(this.name, ClearbitErrorCode.AUTH_FAILED, 401, null, 'Call connect() first')
  }
}

export function createClearbitConnector(): ClearbitConnector {
  const c = new ClearbitConnector()
  c.connect({ apiKey: process.env.CLEARBIT_API_KEY! })
  return c
}
