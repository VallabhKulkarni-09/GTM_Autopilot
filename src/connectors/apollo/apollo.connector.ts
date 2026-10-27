/**
 * apollo.connector.ts
 * Apollo.io enrichment connector implementing Connector<ApolloConfig>.
 *
 * Auth: API key in x-api-key header (NOT Bearer). Single key per org, stored in
 *       connector_config.credentials_vault_key, scoped to organizationId.
 *
 * Endpoint: POST https://api.apollo.io/api/v1/people/match
 *
 * THREE-WAY OUTCOME DISTINCTION (non-negotiable — mirrors the fix in enrich.ts):
 *   1. Network / API error        → throw ConnectorError (AP_ENRICH_FAILED)
 *   2. HTTP 200 but match_confidence === 'none' → return null (caller logs enrichment_skipped)
 *   3. HTTP 200 with real data    → return ApolloPersonMatch
 *
 * The 'none' case is NOT an error. Apollo returns HTTP 200 with a sparse person object
 * when it cannot find a match. If the caller conflates this with an error, or silently
 * returns [] when match_confidence='none', it reproduces the exact Clearbit silent-null
 * bug fixed in evidence-store.ts this session. Do not add .catch(() => null) here.
 *
 * Sequences (v1 outreach): findContactByEmail, createContact, listSequences,
 * listEmailAccounts, addContactToSequence. See the "Sequences" section below.
 *
 * Confidence score: APOLLO_ENRICHMENT_CONFIDENCE = 0.85 (static, not dynamic).
 * Named and exported so callers can reference the constant explicitly.
 * The value is static: Apollo does not report per-field confidence.
 */

import { Connector, ConnectorError, ConnectorHealth, withRetry } from '../base.js'
import { ApolloErrorCode } from './apollo.errors.js'
import type {
  ApolloConfig,
  ApolloEnrichOptions,
  ApolloPersonMatch,
  ApolloPeopleMatchResponse,
  ApolloRawPerson,
  ApolloOrganizationMatch,
  ApolloOrganizationEnrichResponse,
  ApolloRawOrganization,
  ApolloRawContact,
  ApolloContact,
  ApolloContactsSearchResponse,
  ApolloContactCreateResponse,
  ApolloCreateContactInput,
  ApolloSequence,
  ApolloSequencesSearchResponse,
  ApolloEmailAccount,
  ApolloEmailAccountsResponse,
  ApolloAddContactsResponse,
  ApolloSequenceEnrollment,
} from './apollo.types.js'

/** Upper bound when paging through sequences (100 per page). */
const MAX_SEQUENCE_PAGES = 10

const APOLLO_BASE = 'https://api.apollo.io/api/v1'

/**
 * Static confidence score for Apollo enrichment results.
 *
 * This is NOT dynamic / field-level scoring.
 * It is a named static constant: 0.85.
 * Rationale for 0.85 (not 1.0):
 *   - Apollo has high coverage (240M+ contacts) but data freshness varies
 *   - match_confidence 'medium' / 'low' results may be stale or approximate
 *   - We do not yet vary this per-result based on match_confidence
 *   - Stated plainly: if both Apollo and ZoomInfo have data, Apollo "wins"
 *     because 0.85 > 0.9 is wrong — the value must be set relative to ZoomInfo's
 *     when that is wired. For now this is a placeholder that will need tuning
 *     once both sources are live simultaneously.
 *
 * Confidence 0.85 is a fixed value, not computed per field.
 */
export const APOLLO_ENRICHMENT_CONFIDENCE = 0.85

// ── Connector ─────────────────────────────────────────────────────────────────

export class ApolloConnector implements Connector<ApolloConfig> {
  readonly name    = 'apollo' as const
  readonly version = '1.0.0'

  private config: ApolloConfig | null = null

  async connect(config: ApolloConfig): Promise<void> {
    this.config = { ...config }
  }

  async disconnect(): Promise<void> {
    this.config = null
  }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now()
    try {
      // Use org endpoint for health check — people/match is out of scope on this plan.
      // A no-match result (empty {}) on a nonsense domain still confirms auth works.
      await this.rawOrganizationEnrich('health-check-probe-invalid.invalid')
      return { ok: true, latencyMs: Date.now() - start, lastChecked: new Date() }
    } catch (err: any) {
      return {
        ok:          false,
        latencyMs:   Date.now() - start,
        lastChecked: new Date(),
        error:       err?.message ?? String(err),
      }
    }
  }

  // ── Public Methods ──────────────────────────────────────────────────────────

  /**
   * Enriches a company by domain using GET /api/v1/organizations/enrich.
   *
   * PLAN SCOPE: This endpoint is the ONLY enrichment endpoint available on
   * the current Apollo plan. people/match is NOT authorized (403). Do not call it.
   *
   * THREE-WAY OUTCOME (non-negotiable):
   *   → throws ConnectorError(AP_*)      : API/network error, auth failure, scope issue, rate limit
   *   → returns null                     : HTTP 200, organization key absent in response body (no match)
   *   → returns ApolloOrganizationMatch  : HTTP 200, organization present with real data
   *
   * No-match on Apollo org endpoint: HTTP 200 with body {} (empty object).
   * NOT a 404. The caller must check for null explicitly — do not treat null as an error.
   *
   * CALLER CONTRACT:
   *   - On throw  → log enrichment_failed, capture in snapshot
   *   - On null   → log enrichment_skipped with reason 'no_match'
   *   - On match  → store evidence, log enrichment_succeeded
   *
   * The free-email-domain check (gmail.com etc.) happens BEFORE this call in enrich.ts
   * so API credits are not wasted and the skip reason is explicit in the audit trail.
   */
  async enrichOrganizationByDomain(domain: string): Promise<ApolloOrganizationMatch | null> {
    return withRetry(this.name, ApolloErrorCode.ENRICH_FAILED, async () => {
      const raw = await this.rawOrganizationEnrich(domain)
      if (!raw) return null
      return this.mapToOrganizationMatch(raw)
    })
  }

  /**
   * @deprecated people/match is NOT authorized on the current Apollo plan (403).
   * This method is retained for completeness but MUST NOT be called in production.
   * It will throw AP_INSUFFICIENT_SCOPE immediately.
   * If the plan is upgraded to include people data, remove this deprecation.
   */
  async enrichByEmail(
    email: string,
    options: ApolloEnrichOptions = {}
  ): Promise<ApolloPersonMatch | null> {
    throw new ConnectorError(
      this.name, ApolloErrorCode.INSUFFICIENT_SCOPE, 403, null,
      'Apollo people/match is NOT authorized on this plan. ' +
      'Only organizations/enrich is available. ' +
      'Use enrichOrganizationByDomain() instead.'
    )
  }

  // ── Public Methods: Sequences ───────────────────────────────────────────────
  // Endpoints confirmed in docs.apollo.io (2026-10-26). All need a master API key
  // or a key whose scope includes the endpoint; otherwise Apollo returns 403 →
  // AP_INSUFFICIENT_SCOPE.

  /**
   * Finds an existing Apollo contact by exact email (POST /contacts/search).
   * q_keywords is a fuzzy search, so results are filtered to an exact,
   * case-insensitive email match. Returns null when there is none.
   */
  async findContactByEmail(email: string): Promise<ApolloContact | null> {
    return this.retry(ApolloErrorCode.CONTACT_FAILED, async () => {
      const data = await this.request<ApolloContactsSearchResponse>(
        'POST', '/contacts/search', ApolloErrorCode.CONTACT_FAILED,
        { q_keywords: email, page: 1, per_page: 25 },
      )
      const wanted = email.trim().toLowerCase()
      const match = (data.contacts ?? []).find(c => c.email?.trim().toLowerCase() === wanted)
      return match ? mapContact(match) : null
    })
  }

  /**
   * Creates a contact (POST /contacts) with run_dedupe=true, so Apollo returns the
   * existing contact instead of a duplicate if one already matches. Apollo has no
   * idempotency header; run_dedupe is what makes a retried call safe. The key is
   * accepted per the connector contract and included in error messages.
   */
  async createContact(input: ApolloCreateContactInput, idempotencyKey: string): Promise<ApolloContact> {
    const data = await this.retry(ApolloErrorCode.CONTACT_FAILED, async () => {
      const body: Record<string, unknown> = { email: input.email, run_dedupe: true }
      if (input.firstName)        body.first_name        = input.firstName
      if (input.lastName)         body.last_name         = input.lastName
      if (input.title)            body.title             = input.title
      if (input.organizationName) body.organization_name = input.organizationName
      if (input.websiteUrl)       body.website_url       = input.websiteUrl
      return this.request<ApolloContactCreateResponse>(
        'POST', '/contacts', ApolloErrorCode.CONTACT_FAILED, body,
      )
    })
    // Outside retry: an unexpected 200 body will not change on a second try.
    if (!data?.contact?.id) {
      throw new ConnectorError(
        this.name, ApolloErrorCode.CONTACT_FAILED, 200, data,
        `Apollo POST /contacts returned no contact id (idempotencyKey=${idempotencyKey})`,
      )
    }
    return mapContact(data.contact)
  }

  /** Lists sequences that are not archived (POST /emailer_campaigns/search, paged). */
  async listSequences(): Promise<ApolloSequence[]> {
    return this.retry(ApolloErrorCode.SEQUENCE_FAILED, async () => {
      const out: ApolloSequence[] = []
      for (let page = 1; page <= MAX_SEQUENCE_PAGES; page++) {
        const data = await this.request<ApolloSequencesSearchResponse>(
          'POST', '/emailer_campaigns/search', ApolloErrorCode.SEQUENCE_FAILED,
          { page, per_page: 100 },
        )
        for (const s of data.emailer_campaigns ?? []) {
          if (!s.archived) out.push({ id: s.id, name: s.name, active: s.active === true })
        }
        if (page >= (data.pagination?.total_pages ?? 0)) break
      }
      return out
    })
  }

  /** Lists the team's sending mailboxes (GET /email_accounts). */
  async listEmailAccounts(): Promise<ApolloEmailAccount[]> {
    return this.retry(ApolloErrorCode.SEQUENCE_FAILED, async () => {
      const data = await this.request<ApolloEmailAccountsResponse>(
        'GET', '/email_accounts', ApolloErrorCode.SEQUENCE_FAILED,
      )
      return (data.email_accounts ?? []).map(a => ({
        id: a.id, email: a.email, active: a.active === true, isDefault: a.default === true,
      }))
    })
  }

  /**
   * Adds one contact to a sequence (POST /emailer_campaigns/{id}/add_contact_ids).
   *
   * Apollo answers HTTP 200 even when it refuses a contact; the refusal shows up in
   * skipped_contact_ids (e.g. "contact_not_found", already in another sequence).
   * That is NOT success: it throws AP_SEQUENCE_FAILED with Apollo's reason, so the
   * lead is escalated instead of being marked in_sequence.
   *
   * sequence_unverified_email=true: inbound leads typed this address themselves,
   * so Apollo's "unverified" status should not block outreach. Other Apollo safety
   * checks (already in another sequence, job change, same company) stay on.
   */
  async addContactToSequence(
    contactId: string,
    sequenceId: string,
    emailAccountId: string,
    idempotencyKey: string,
  ): Promise<ApolloSequenceEnrollment> {
    const data = await this.retry(ApolloErrorCode.SEQUENCE_FAILED, async () => {
      const qs = new URLSearchParams({
        emailer_campaign_id:              sequenceId,
        send_email_from_email_account_id: emailAccountId,
        sequence_unverified_email:        'true',
      })
      qs.append('contact_ids[]', contactId)
      return this.request<ApolloAddContactsResponse>(
        'POST',
        `/emailer_campaigns/${encodeURIComponent(sequenceId)}/add_contact_ids?${qs.toString()}`,
        ApolloErrorCode.SEQUENCE_FAILED,
      )
    })

    const skippedReason = data?.skipped_contact_ids?.[contactId]
    const contact = (data?.contacts ?? []).find(c => c.id === contactId)
    const inSequence = !!contact?.emailer_campaign_ids?.includes(sequenceId)
    if (skippedReason || !inSequence) {
      throw new ConnectorError(
        this.name, ApolloErrorCode.SEQUENCE_FAILED, 200, data,
        `Apollo did not add contact ${contactId} to sequence ${sequenceId}: ` +
        `${skippedReason ?? 'contact not in sequence after the call'} (idempotencyKey=${idempotencyKey})`,
      )
    }
    const status = contact?.contact_campaign_statuses?.find(s => s.emailer_campaign_id === sequenceId)
    return { contactId, sequenceId, campaignStatusId: status?.id ?? null }
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * withRetry, except Apollo 422 (validation — our request or their config) is not
   * retried: retrying cannot fix it. withRetry only skips 400/401/403/404.
   */
  private async retry<T>(operationCode: string, fn: () => Promise<T>): Promise<T> {
    let fatal: ConnectorError | null = null
    try {
      return await withRetry(this.name, operationCode, async () => {
        try {
          return await fn()
        } catch (e) {
          if (e instanceof ConnectorError && e.statusCode === 422) {
            fatal = e
            throw new ConnectorError(this.name, e.code, 400, e.raw, e.message) // stop retrying
          }
          throw e
        }
      })
    } catch (e) {
      if (fatal) throw fatal
      throw e
    }
  }

  /** One Apollo HTTP call with the shared status → ConnectorError mapping. */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    operationCode: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    this.assertConnected()
    const endpoint = path.split('?')[0]
    let res: Response
    try {
      res = await fetch(`${APOLLO_BASE}${path}`, {
        method,
        headers: this.headers(),
        body:    body ? JSON.stringify(body) : undefined,
        signal:  AbortSignal.timeout(15_000),
      })
    } catch (err: any) {
      throw new ConnectorError(
        this.name, ApolloErrorCode.NETWORK_ERROR, 0, String(err),
        `Apollo ${endpoint} network error: ${err?.message ?? String(err)}`,
      )
    }

    if (res.ok) {
      const text = await res.text()
      try {
        return JSON.parse(text) as T
      } catch {
        throw new ConnectorError(this.name, operationCode, res.status, text, `Apollo ${endpoint} returned non-JSON`)
      }
    }

    const raw = await res.text()
    if (res.status === 401) {
      throw new ConnectorError(this.name, ApolloErrorCode.AUTH_FAILED, 401, raw,
        'Apollo API authentication failed (401). Check the Apollo API key.')
    }
    if (res.status === 403) {
      throw new ConnectorError(this.name, ApolloErrorCode.INSUFFICIENT_SCOPE, 403, raw,
        `Apollo ${endpoint} returned 403. The API key does not include this endpoint ` +
        `(Sequences need a master key or a key scoped to contacts, sequences and email accounts).`)
    }
    if (res.status === 429) {
      throw new ConnectorError(this.name, ApolloErrorCode.RATE_LIMITED, 429, raw,
        `Apollo rate limit hit on ${endpoint}.`)
    }
    throw new ConnectorError(this.name, operationCode, res.status, raw,
      `Apollo ${endpoint} failed with status ${res.status}: ${raw.slice(0, 300)}`)
  }

  /**
   * Makes the raw POST /people/match call.
   * Returns:
   *   - null    : HTTP 200 but match_confidence === 'none' (no Apollo record)
   *   - raw     : HTTP 200 with a real person object
   * Throws ConnectorError on any non-200, network failure, or missing person in response.
   *
   * Note: POST body params, not query params. Apollo accepts both but body is more reliable
   * for large payloads and avoids URL encoding issues with emails.
   */
  private async rawMatch(
    params: { email?: string; first_name?: string; last_name?: string; domain?: string },
    options: ApolloEnrichOptions
  ): Promise<ApolloRawPerson | null> {
    this.assertConnected()

    const body: Record<string, unknown> = { ...params }
    if (options.revealPersonalEmails) body.reveal_personal_emails = true
    if (options.revealPhoneNumber)    body.reveal_phone_number    = true
    if (options.runWaterfallEmail)    body.run_waterfall_email    = true

    let res: Response
    try {
      res = await fetch(`${APOLLO_BASE}/people/match`, {
        method:  'POST',
        headers: {
          'x-api-key':    this.config!.apiKey,
          'Content-Type': 'application/json',
          'Accept':       'application/json',
        },
        body:   JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err: any) {
      // Network-level failure (ECONNREFUSED, AbortError, etc.) — wrap as ConnectorError
      throw new ConnectorError(
        this.name, ApolloErrorCode.NETWORK_ERROR, 0, String(err),
        `Apollo people/match network error: ${err?.message ?? String(err)}`
      )
    }

    // Auth errors — do not retry
    if (res.status === 401 || res.status === 403) {
      const raw = await res.text()
      throw new ConnectorError(
        this.name, ApolloErrorCode.AUTH_FAILED, res.status, raw,
        `Apollo API authentication failed (status ${res.status}). Check APOLLO_API_KEY.`
      )
    }

    if (!res.ok) {
      const raw = await res.text()
      throw new ConnectorError(
        this.name, ApolloErrorCode.ENRICH_FAILED, res.status, raw,
        `Apollo people/match failed with status ${res.status}`
      )
    }

    const data = await res.json() as ApolloPeopleMatchResponse

    // Apollo returns HTTP 200 even when there's no match.
    // The signal is match_confidence === 'none'.
    // A missing person object or match_confidence='none' both mean: no record found.
    if (!data.person || data.person.match_confidence === 'none') {
      return null
    }

    return data.person
  }

  /**
   * Maps the raw Apollo person response to ApolloPersonMatch.
   * Only maps fields we actually read from the real response — no assumed fields.
   * The full _raw object is preserved so evidence rows have the complete payload.
   */
  private mapToPersonMatch(raw: ApolloRawPerson): ApolloPersonMatch {
    const org = raw.organization ?? null

    return {
      apolloId:    raw.id,
      email:       raw.email        ?? null,
      firstName:   raw.first_name   ?? null,
      lastName:    raw.last_name    ?? null,
      fullName:    raw.name         ?? null,
      title:       raw.title        ?? null,
      linkedinUrl: raw.linkedin_url ?? null,
      location: {
        city:    raw.city    ?? null,
        state:   raw.state   ?? null,
        country: raw.country ?? null,
      },
      matchConfidence: raw.match_confidence,
      company: org ? {
        apolloOrgId:   org.id             ?? null,
        name:          org.name           ?? null,
        domain:        org.primary_domain ?? null,
        industry:      org.industry       ?? null,
        employeeCount: org.estimated_num_employees ?? null,
        annualRevenue: org.annual_revenue          ?? null,
        fundingStage:  org.latest_funding_stage    ?? null,
        country:       org.country                 ?? null,
      } : null,
      _raw: raw,
    }
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key':    this.config!.apiKey,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    }
  }

  private assertConnected(): void {
    if (!this.config) {
      throw new ConnectorError(
        this.name, ApolloErrorCode.NOT_CONNECTED, 401, null,
        'ApolloConnector: call connect() before any API operation'
      )
    }
  }

  // ── Private: Organization Enrichment ────────────────────────────────────────

  /**
   * Calls GET /api/v1/organizations/enrich?domain={domain}.
   *
   * Returns:
   *   - null              : HTTP 200, body is {} — organization key absent (no match)
   *   - ApolloRawOrganization : HTTP 200, organization key present with real data
   *
   * Throws ConnectorError for:
   *   - 401 → AP_AUTH_FAILED       (bad key)
   *   - 403 → AP_INSUFFICIENT_SCOPE (plan doesn't include this endpoint — handle loudly)
   *   - 422 → AP_ENRICH_FAILED     (missing/invalid identifier — shouldn't happen since domain is always passed)
   *   - 429 → AP_RATE_LIMITED      (allow caller to degrade gracefully)
   *   - Network → AP_NETWORK_ERROR
   *
   * VERIFIED: Real Apollo API for stripe.com returns HTTP 200 with { organization: {...} }.
   * VERIFIED: Real Apollo API for zzz-no-such-company-xyz123.invalid returns HTTP 200 with {}.
   * VERIFIED: gmail.com also returns {} (Apollo itself doesn't return data for webmail).
   */
  private async rawOrganizationEnrich(domain: string): Promise<ApolloRawOrganization | null> {
    this.assertConnected()

    let res: Response
    const url = `${APOLLO_BASE}/organizations/enrich?domain=${encodeURIComponent(domain)}`
    try {
      res = await fetch(url, {
        method:  'GET',
        headers: this.headers(),
        signal:  AbortSignal.timeout(15_000),
      })
    } catch (err: any) {
      throw new ConnectorError(
        this.name, ApolloErrorCode.NETWORK_ERROR, 0, String(err),
        `Apollo organizations/enrich network error for domain "${domain}": ${err?.message ?? String(err)}`
      )
    }

    if (res.status === 401) {
      const raw = await res.text()
      throw new ConnectorError(
        this.name, ApolloErrorCode.AUTH_FAILED, 401, raw,
        `Apollo API authentication failed (401). Check APOLLO_API_KEY.`
      )
    }

    if (res.status === 403) {
      const raw = await res.text()
      throw new ConnectorError(
        this.name, ApolloErrorCode.INSUFFICIENT_SCOPE, 403, raw,
        `Apollo organizations/enrich returned 403 Forbidden. ` +
        `This endpoint requires a plan that includes organization enrichment. ` +
        `Check Apollo plan or API key scope.`
      )
    }

    if (res.status === 422) {
      const raw = await res.text()
      throw new ConnectorError(
        this.name, ApolloErrorCode.ENRICH_FAILED, 422, raw,
        `Apollo organizations/enrich returned 422 Unprocessable for domain "${domain}". ` +
        `Raw: ${raw}`
      )
    }

    if (res.status === 429) {
      const raw = await res.text()
      throw new ConnectorError(
        this.name, ApolloErrorCode.RATE_LIMITED, 429, raw,
        `Apollo API rate limit hit. Enrich call for domain "${domain}" will be retried by caller.`
      )
    }

    if (!res.ok) {
      const raw = await res.text()
      throw new ConnectorError(
        this.name, ApolloErrorCode.ENRICH_FAILED, res.status, raw,
        `Apollo organizations/enrich failed with status ${res.status} for domain "${domain}"`
      )
    }

    const data = await res.json() as ApolloOrganizationEnrichResponse

    // No-match: Apollo returns HTTP 200 with body {} — organization key is absent.
    // This is NOT a 404. Must check for absence explicitly, not rely on status code.
    // Verified against real API: zzz-no-such-company.invalid → {} → organization is undefined.
    if (!data || !data.organization) {
      return null
    }

    return data.organization
  }

  /**
   * Maps the raw Apollo organization response to ApolloOrganizationMatch.
   * Field names verified against real stripe.com response (2026-10-05).
   * Full _raw preserved for evidence audit.
   */
  private mapToOrganizationMatch(raw: ApolloRawOrganization): ApolloOrganizationMatch {
    return {
      apolloOrgId:    raw.id,
      name:           raw.name           ?? null,
      domain:         raw.primary_domain ?? null,
      industry:       raw.industry       ?? null,
      industries:     raw.industries     ?? [],
      employeeCount:  raw.estimated_num_employees ?? null,
      revenue:        raw.organization_revenue    ?? null,  // verified field name
      revenuePrinted: raw.organization_revenue_printed ?? null,
      totalFunding:   raw.total_funding  ?? null,
      fundingStage:   raw.latest_funding_stage ?? null,
      foundedYear:    raw.founded_year   ?? null,
      location: {
        city:    raw.city    ?? null,   // top-level, verified
        state:   raw.state   ?? null,   // top-level, verified
        country: raw.country ?? null,   // top-level, verified ("United States" not ISO code)
      },
      techStack: raw.technology_names ?? [],
      _raw: raw,
    }
  }
}

function mapContact(raw: ApolloRawContact): ApolloContact {
  return { id: raw.id, email: raw.email ?? null, sequenceIds: raw.emailer_campaign_ids ?? [] }
}

// ── Exported Utilities ────────────────────────────────────────────────────────

/**
 * Derives an email domain for use with Apollo organizations/enrich.
 *
 * Returns null for:
 *   - Emails with no @ character
 *   - Domains with no dot (invalid TLD — these won't resolve)
 *   - Empty/null emails
 *
 * The caller is responsible for checking against FREE_EMAIL_PROVIDERS before
 * calling enrichOrganizationByDomain. This function only validates structure,
 * not whether the domain is a free email provider.
 */
export function deriveDomainFromEmail(email: string): string | null {
  const domain = email?.split('@')[1]?.toLowerCase().trim()
  if (!domain || !domain.includes('.')) return null
  return domain
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates and connects an ApolloConnector from environment variables.
 * Returns null when APOLLO_API_KEY is not set, so callers can skip Apollo gracefully.
 *
 * NEVER throw when the key is missing — missing key = connector not configured,
 * not an error. The enrichment node checks for null and skips Apollo if absent.
 */
export function createApolloConnector(): ApolloConnector | null {
  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) return null

  const connector = new ApolloConnector()
  connector.connect({ apiKey })
  return connector
}
