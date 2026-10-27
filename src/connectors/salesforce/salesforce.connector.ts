/**
 * salesforce.connector.ts
 * Salesforce connector implementing Connector<SalesforceConfig>.
 *
 * Credentials: SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_SANDBOX
 */

import { Connector, ConnectorError, ConnectorHealth, withRetry } from '../base.js'
import { SalesforceErrorCode } from './salesforce.errors.js'
import type {
  SalesforceConfig,
  SalesforceLead,
  SalesforceTask,
  SalesforceUser,
  SalesforceTokenResponse,
  SalesforceQueryResponse,
  SalesforceCreateResponse,
  CreateLeadInput,
  CreateTaskInput,
  UserFilter,
} from './salesforce.types.js'

export type AccountMatch = {
  accountId: string
  accountOwnerId: string
  accountOwnerName: string
  openOpportunityId: string | null
  openOpportunityOwnerId: string | null
  openOpportunityOwnerName: string | null
}

export class SalesforceConnector implements Connector<SalesforceConfig> {
  readonly name = 'salesforce' as const
  readonly version = '1.0.0'

  private accessToken: string | null = null
  private tokenExpiresAt: number = 0
  private config: SalesforceConfig | null = null

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(config: SalesforceConfig): Promise<void> {
    this.config = config
    await this.refreshToken()
  }

  async disconnect(): Promise<void> {
    this.accessToken = null
    this.tokenExpiresAt = 0
    this.config = null
  }

  async healthCheck(): Promise<ConnectorHealth> {
    const start = Date.now()
    try {
      await this.query<{ Id: string }>('SELECT Id FROM User LIMIT 1')
      return { ok: true, latencyMs: Date.now() - start, lastChecked: new Date() }
    } catch (err) {
      const msg = err instanceof ConnectorError ? err.message : String(err)
      return { ok: false, latencyMs: Date.now() - start, lastChecked: new Date(), error: msg }
    }
  }

  // ─── Lead Methods ───────────────────────────────────────────────────────────

  async getLeadById(id: string): Promise<SalesforceLead> {
    return withRetry(this.name, SalesforceErrorCode.LEAD_QUERY_FAILED, async () => {
      const token = await this.getValidToken()
      const fields = 'Id,FirstName,LastName,Email,Title,Phone,Company,LeadSource,Status,OwnerId,CreatedDate,LastModifiedDate'
      const res = await fetch(`${this.config!.instanceUrl}/services/data/v59.0/sobjects/Lead/${id}?fields=${fields}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      })
      if (res.status === 404) {
        throw new ConnectorError(this.name, SalesforceErrorCode.LEAD_NOT_FOUND, 404, await res.text(), `Lead ${id} not found in Salesforce`)
      }
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, SalesforceErrorCode.LEAD_QUERY_FAILED, res.status, raw, `Failed to get lead ${id}`)
      }
      return res.json() as Promise<SalesforceLead>
    })
  }

  async createLead(data: CreateLeadInput, idempotencyKey: string): Promise<SalesforceLead> {
    return withRetry(this.name, SalesforceErrorCode.LEAD_CREATE_FAILED, async () => {
      const token = await this.getValidToken()
      const body = {
        FirstName: data.firstName,
        LastName: data.lastName,
        Email: data.email,
        Title: data.title,
        Phone: data.phone,
        Company: data.company ?? '[Unknown]',
        LeadSource: data.leadSource,
        Description: `idempotency_key:${idempotencyKey}`,
      }
      const res = await fetch(`${this.config!.instanceUrl}/services/data/v59.0/sobjects/Lead`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, SalesforceErrorCode.LEAD_CREATE_FAILED, res.status, raw, 'Failed to create lead in Salesforce')
      }
      const created = await res.json() as SalesforceCreateResponse
      return this.getLeadById(created.id)
    })
  }

  async updateLead(id: string, data: Partial<SalesforceLead>, idempotencyKey: string): Promise<void> {
    await withRetry(this.name, SalesforceErrorCode.LEAD_UPDATE_FAILED, async () => {
      const token = await this.getValidToken()
      const body = { ...data, Description: `idempotency_key:${idempotencyKey}` }
      // Remove read-only fields
      delete (body as Record<string, unknown>).Id
      delete (body as Record<string, unknown>).CreatedDate
      delete (body as Record<string, unknown>).LastModifiedDate

      const res = await fetch(`${this.config!.instanceUrl}/services/data/v59.0/sobjects/Lead/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      })
      if (res.status === 404) {
        throw new ConnectorError(this.name, SalesforceErrorCode.LEAD_NOT_FOUND, 404, '', `Lead ${id} not found`)
      }
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, SalesforceErrorCode.LEAD_UPDATE_FAILED, res.status, raw, `Failed to update lead ${id}`)
      }
    })
  }

  async assignLeadOwner(leadId: string, ownerId: string, idempotencyKey: string): Promise<void> {
    await withRetry(this.name, SalesforceErrorCode.LEAD_ASSIGN_FAILED, async () => {
      const token = await this.getValidToken()
      const res = await fetch(`${this.config!.instanceUrl}/services/data/v59.0/sobjects/Lead/${leadId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ OwnerId: ownerId, Description: `idempotency_key:${idempotencyKey}` }),
        signal: AbortSignal.timeout(8_000),
      })
      if (res.status === 404) {
        throw new ConnectorError(this.name, SalesforceErrorCode.LEAD_NOT_FOUND, 404, '', `Lead ${leadId} not found`)
      }
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, SalesforceErrorCode.LEAD_ASSIGN_FAILED, res.status, raw, `Failed to assign lead ${leadId} to owner ${ownerId}`)
      }
    })
  }

  async createTask(leadId: string, task: CreateTaskInput, idempotencyKey: string): Promise<SalesforceTask> {
    return withRetry(this.name, SalesforceErrorCode.TASK_CREATE_FAILED, async () => {
      const token = await this.getValidToken()
      const body = {
        WhoId: leadId,
        OwnerId: task.ownerId,
        Subject: task.subject,
        ActivityDate: task.dueDate,
        Description: task.description ?? `idempotency_key:${idempotencyKey}`,
        Status: task.status ?? 'Not Started',
      }
      const res = await fetch(`${this.config!.instanceUrl}/services/data/v59.0/sobjects/Task`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, SalesforceErrorCode.TASK_CREATE_FAILED, res.status, raw, 'Failed to create task in Salesforce')
      }
      const created = await res.json() as SalesforceCreateResponse
      // Fetch the created task
      const taskRes = await fetch(
        `${this.config!.instanceUrl}/services/data/v59.0/sobjects/Task/${created.id}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) }
      )
      return taskRes.json() as Promise<SalesforceTask>
    })
  }

  async getUsers(filter?: UserFilter): Promise<SalesforceUser[]> {
    return withRetry(this.name, SalesforceErrorCode.USER_QUERY_FAILED, async () => {
      // Only people who can own leads: full Salesforce licence users. Excludes system and
      // integration users (Automated Process, Integration User, Chatter Expert, Security User),
      // which a live import showed round-robin would otherwise assign leads to.
      const active = filter?.isActive === false ? 'false' : 'true'
      const result = await this.query<SalesforceUser>(
        `SELECT+Id,+Name,+Email,+IsActive,+UserRole.Name,+Profile.Name+FROM+User+WHERE+IsActive+=+${active}` +
        `+AND+UserType+=+'Standard'+AND+Profile.UserLicense.Name+=+'Salesforce'+ORDER+BY+Name`, false)
      return result
    })
  }

  async matchAccountByDomain(
    domain: string,
    idempotencyKey: string
  ): Promise<AccountMatch | null> {
    return withRetry(this.name, 'ACCOUNT_MATCH_FAILED', async () => {
      const token = await this.getValidToken()
      const soql = [
        'SELECT Id, OwnerId, Owner.Name,',
        '  (SELECT Id, StageName, OwnerId, Owner.Name FROM Opportunities WHERE IsClosed = false ORDER BY CreatedDate DESC LIMIT 1)',
        'FROM Account',
        `WHERE Website LIKE '%${domain}%' OR Website LIKE '%${domain.replace(/^www\./, '')}%'`,
        'LIMIT 1',
      ].join(' ')

      const url = `${this.config!.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) {
        const raw = await res.text()
        throw new ConnectorError(this.name, 'ACCOUNT_MATCH_FAILED', res.status, raw, `matchAccountByDomain failed for domain ${domain}`)
      }
      const raw = await res.json() as { records: any[]; totalSize: number }

      if (!raw.records || raw.records.length === 0) return null

      const account = raw.records[0]
      const opp = account?.Opportunities?.records?.[0] ?? null

      return {
        accountId: account.Id,
        accountOwnerId: account.OwnerId,
        accountOwnerName: account.Owner?.Name ?? 'Unknown',
        openOpportunityId: opp?.Id ?? null,
        openOpportunityOwnerId: opp?.OwnerId ?? null,
        openOpportunityOwnerName: opp?.Owner?.Name ?? null,
      }
    })
  }

  /**
   * Find a Salesforce Lead by email address.
   * Returns the Lead's SF Id if found, null if not.
   * Used for find-or-create to avoid DUPLICATE_VALUE errors.
   */
  async findLeadByEmail(email: string): Promise<{ Id: string } | null> {
    const safeEmail = email.replace(/'/g, "\\'")
    const records = await this.query<{ Id: string }>(
      `SELECT Id FROM Lead WHERE Email = '${safeEmail}' LIMIT 1`
    )
    return records.length > 0 ? records[0] : null
  }


  private async query<T>(soql: string, encode = true): Promise<T[]> {
    const token = await this.getValidToken()
    const q = encode ? encodeURIComponent(soql) : soql
    const res = await fetch(`${this.config!.instanceUrl}/services/data/v59.0/query?q=${q}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) {
      const raw = await res.text()
      throw new ConnectorError(this.name, SalesforceErrorCode.REQUEST_FAILED, res.status, raw, `SOQL query failed`)
    }
    const data = await res.json() as SalesforceQueryResponse<T>
    return data.records
  }

  private async getValidToken(): Promise<string> {
    if (!this.config) throw new ConnectorError(this.name, SalesforceErrorCode.AUTH_FAILED, 401, null, 'Connector not connected. Call connect() first.')
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken
    await this.refreshToken()
    return this.accessToken!
  }

  private async refreshToken(): Promise<void> {
    const { clientId, clientSecret, instanceUrl, sandbox } = this.config!

    // Standard orgs: login.salesforce.com
    // Sandbox orgs:  test.salesforce.com
    // Custom-domain orgs (e.g. Developer Edition / OrgFarm with *.my.salesforce.com):
    //   must authenticate against their own domain, not login.salesforce.com
    const isCustomDomain = instanceUrl.includes('.my.salesforce.com') && !instanceUrl.startsWith('https://login') && !instanceUrl.startsWith('https://test')
    const loginUrl = isCustomDomain
      ? instanceUrl
      : sandbox
        ? 'https://test.salesforce.com'
        : 'https://login.salesforce.com'

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    })

    const res = await fetch(`${loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(8_000),
    })

    if (!res.ok) {
      const raw = await res.text()
      throw new ConnectorError(this.name, SalesforceErrorCode.AUTH_FAILED, res.status, raw, 'Salesforce OAuth token request failed')
    }

    const token = await res.json() as SalesforceTokenResponse
    this.accessToken = token.access_token
    this.tokenExpiresAt = Date.now() + 55 * 60 * 1000  // 55 min (tokens expire at 60min)
  }
}

// ─── Singleton factory ─────────────────────────────────────────────────────────

export function createSalesforceConnector(): SalesforceConnector {
  const config: SalesforceConfig = {
    instanceUrl: process.env.SF_INSTANCE_URL!,
    clientId:    process.env.SF_CLIENT_ID!,
    clientSecret:process.env.SF_CLIENT_SECRET!,
    sandbox:     process.env.SF_SANDBOX === 'true',
  }
  const connector = new SalesforceConnector()
  // connect() is called lazily on first use
  return connector
}
