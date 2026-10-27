/**
 * events.ts — Salesforce Event object queries for outcome tracking.
 *
 * All functions in this file:
 * - Accept a connected SalesforceConnector instance (caller handles connect/auth)
 * - Return typed results or null (never throw for missing data)
 * - Throw ConnectorError (never raw Error) for API/permission failures
 * - Never hardcode meeting type strings or SF field API names
 *
 * Permission detection:
 * SF returns HTTP 400 with errorCode INVALID_TYPE or
 * INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY when the Event object
 * is inaccessible due to missing OAuth scope or field-level security.
 * Both are caught and re-thrown as ConnectorError with code
 * SF_EVENT_OBJECT_NOT_ACCESSIBLE so the poller can log them without crashing.
 */

import { SalesforceConnector } from './salesforce.connector.js'
import { ConnectorError } from '../base.js'
import { SalesforceErrorCode } from './salesforce.errors.js'
import type { SalesforceEvent, SalesforceQueryResponse } from './salesforce.types.js'

const SF_CONNECTOR_NAME = 'salesforce' as const

// SF error codes that indicate the Event object/field is inaccessible
const SF_SCOPE_ERROR_CODES = new Set([
  'INVALID_TYPE',
  'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
  'INVALID_FIELD',
  'NO_SUCH_COLUMN',
])

// ── SOQL helpers ─────────────────────────────────────────────────────────────

/** Escapes a single string for safe embedding in SOQL single-quoted literals. */
function escapeSoqlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')
}

/**
 * Builds a SOQL IN clause from an array of strings.
 * Example: ['Meeting', 'Discovery Call'] → "('Meeting','Discovery Call')"
 * Values are escaped to prevent SOQL injection.
 */
function buildInClause(values: string[]): string {
  return `(${values.map(v => `'${escapeSoqlString(v)}'`).join(',')})`
}

// ── Internal fetch helper ─────────────────────────────────────────────────────

async function soqlFetch<T>(
  connector: SalesforceConnector,
  soql: string,
  errorCode: string,
  scopeErrorMessage: string
): Promise<T[]> {
  const instanceUrl = (connector as any).config?.instanceUrl
  const token = await (connector as any).getValidToken()

  const res = await fetch(
    `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }
  )

  if (!res.ok) {
    const raw = await res.text()
    // Detect permission / scope errors
    let parsed: any
    try { parsed = JSON.parse(raw) } catch { /* ignore */ }
    const sfErrorCode: string = parsed?.[0]?.errorCode ?? parsed?.errorCode ?? ''
    if (SF_SCOPE_ERROR_CODES.has(sfErrorCode)) {
      throw new ConnectorError(
        SF_CONNECTOR_NAME,
        SalesforceErrorCode.EVENT_OBJECT_NOT_ACCESSIBLE,
        res.status,
        raw,
        scopeErrorMessage
      )
    }
    throw new ConnectorError(SF_CONNECTOR_NAME, errorCode, res.status, raw, `SOQL failed: ${soql.slice(0, 100)}`)
  }

  const data = await res.json() as SalesforceQueryResponse<T>
  return data.records
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Queries Salesforce Event objects linked to a Lead/Contact (via WhoId).
 *
 * NOTE: Event.Type does not exist in this org — confirmed via live SF describe
 * query (INVALID_FIELD). This org uses Subject to categorise events.
 * Subject picklist values: ['Call', 'Email', 'Meeting', 'Send Letter/Quote', 'Other']
 * Policy config's primaryMeetingTypes must contain Subject values (e.g. 'Meeting').
 *
 * @param connector        A connected SalesforceConnector instance.
 * @param whoId            The Salesforce Lead or Contact Id (WhoId on Event).
 * @param meetingSubjects  Event.Subject values to match — from org policy, NEVER hardcoded.
 * @param since            Start of the search window.
 * @param until            End of the search window.
 *
 * @throws {ConnectorError} with code SF_EVENT_OBJECT_NOT_ACCESSIBLE if the
 *   Event object is inaccessible (missing OAuth scope or field-level security).
 *   Callers (poller) must catch this and log — never crash the job.
 */
export async function queryMeetingEvents(
  connector: SalesforceConnector,
  whoId: string,
  meetingSubjects: string[],
  since: Date,
  until: Date
): Promise<SalesforceEvent[]> {
  if (meetingSubjects.length === 0) return []

  const sinceIso = since.toISOString()
  const untilIso = until.toISOString()

  // Event.Type does not exist in this SF org (INVALID_FIELD confirmed via live describe).
  // Filter on Subject — the only reliable activity categorisation field available.
  const soql = [
    'SELECT Id, WhoId, Subject, StartDateTime, EndDateTime, ActivityDate, CreatedDate',
    'FROM Event',
    `WHERE WhoId = '${escapeSoqlString(whoId)}'`,
    `AND Subject IN ${buildInClause(meetingSubjects)}`,
    `AND StartDateTime >= ${sinceIso}`,
    `AND StartDateTime <= ${untilIso}`,
    'ORDER BY StartDateTime ASC',
    'LIMIT 200',
  ].join(' ')

  return soqlFetch<SalesforceEvent>(
    connector,
    soql,
    SalesforceErrorCode.EVENT_QUERY_FAILED,
    'Event object not accessible — check OAuth scope (requires api + full or custom Event read permission)'
  )
}

/**
 * Returns the current Status field value for a Salesforce Lead.
 * Returns null if the lead is not found or the field is inaccessible.
 *
 * @throws {ConnectorError} on unexpected API failures.
 */
export async function queryLeadStatus(
  connector: SalesforceConnector,
  leadId: string
): Promise<string | null> {
  const soql = `SELECT Status FROM Lead WHERE Id = '${escapeSoqlString(leadId)}' LIMIT 1`
  const records = await soqlFetch<{ Status: string }>(
    connector,
    soql,
    SalesforceErrorCode.LEAD_STATUS_QUERY_FAILED,
    'Lead Status field not accessible — check field-level security'
  )
  return records.length > 0 ? records[0].Status : null
}

/**
 * Returns the current StageName for an Opportunity.
 * Returns null if the opportunity is not found.
 *
 * @throws {ConnectorError} on API failures.
 */
export async function queryOpportunityStage(
  connector: SalesforceConnector,
  opportunityId: string
): Promise<string | null> {
  const soql = `SELECT StageName FROM Opportunity WHERE Id = '${escapeSoqlString(opportunityId)}' LIMIT 1`
  const records = await soqlFetch<{ StageName: string }>(
    connector,
    soql,
    SalesforceErrorCode.OPPORTUNITY_STAGE_QUERY_FAILED,
    'Opportunity StageName not accessible — check field-level security'
  )
  return records.length > 0 ? records[0].StageName : null
}

/**
 * Returns the boolean value of a custom checkbox field on a Lead.
 * fieldApiName comes from org policy config — never hardcoded here.
 * Returns null if the lead is not found or the field is inaccessible.
 *
 * @throws {ConnectorError} on API failures.
 */
export async function queryCustomCheckbox(
  connector: SalesforceConnector,
  leadId: string,
  fieldApiName: string
): Promise<boolean | null> {
  // Validate field name contains only safe characters before interpolating
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldApiName)) {
    throw new ConnectorError(
      SF_CONNECTOR_NAME,
      SalesforceErrorCode.CUSTOM_FIELD_QUERY_FAILED,
      400,
      null,
      `Invalid SF field API name: '${fieldApiName}' — must match [A-Za-z][A-Za-z0-9_]*`
    )
  }

  const soql = `SELECT ${fieldApiName} FROM Lead WHERE Id = '${escapeSoqlString(leadId)}' LIMIT 1`
  const records = await soqlFetch<Record<string, unknown>>(
    connector,
    soql,
    SalesforceErrorCode.CUSTOM_FIELD_QUERY_FAILED,
    `Custom field '${fieldApiName}' not accessible — check field-level security and API name`
  )
  if (records.length === 0) return null
  const val = records[0][fieldApiName]
  if (typeof val !== 'boolean') return null
  return val
}
