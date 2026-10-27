/**
 * factory.ts — the ONLY place runtime code builds connectors (v1: HubSpot, Salesforce, Apollo).
 *
 * getConnectors(orgId) returns lazily-connected connectors from that workspace's encrypted
 * credentials. A missing connector is `null` — callers must emit an explicit skipped/failed event.
 * Clearbit / Outreach / Salesloft / ZoomInfo / Slack are never constructed in v1.
 *
 * Cache: per org, 5-minute TTL, cleared by invalidateConnectors(orgId) after any save.
 */

import { HubSpotConnector } from './hubspot/hubspot.connector.js'
import { SalesforceConnector } from './salesforce/salesforce.connector.js'
import { ApolloConnector } from './apollo/apollo.connector.js'
import {
  loadConnectorCredentials,
  findOrgByHubspotPortal,
  type V1ConnectorName,
} from '../repositories/connector-credentials.repository.js'

export type OrgConnectors = {
  hubspot(): Promise<HubSpotConnector | null>
  salesforce(): Promise<SalesforceConnector | null>
  apollo(): Promise<ApolloConnector | null>
}

type Deps = { load: typeof loadConnectorCredentials }

const TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; promises: Partial<Record<V1ConnectorName, Promise<unknown>>> }>()

export function invalidateConnectors(organizationId: string): void {
  cache.delete(organizationId)
}

export function createConnectorFactory(deps: Deps = { load: loadConnectorCredentials }) {
  function memo<T>(orgId: string, name: V1ConnectorName, build: () => Promise<T | null>): Promise<T | null> {
    let entry = cache.get(orgId)
    if (!entry || Date.now() - entry.at > TTL_MS) {
      entry = { at: Date.now(), promises: {} }
      cache.set(orgId, entry)
    }
    const existing = entry.promises[name] as Promise<T | null> | undefined
    if (existing) return existing
    const p = build().catch(err => {
      // Do not cache failures (e.g. Salesforce token call failed) — next call retries.
      delete entry!.promises[name]
      throw err
    })
    entry.promises[name] = p
    return p
  }

  return function getConnectors(organizationId: string): OrgConnectors {
    return {
      hubspot: () => memo(organizationId, 'hubspot', async () => {
        const c = await deps.load(organizationId, 'hubspot')
        if (!c) return null
        const hs = new HubSpotConnector()
        await hs.connect({ apiKey: c.secrets.apiKey, webhookSecret: c.secrets.webhookSecret })
        return hs
      }),
      salesforce: () => memo(organizationId, 'salesforce', async () => {
        const c = await deps.load(organizationId, 'salesforce')
        if (!c) return null
        const sf = new SalesforceConnector()
        await sf.connect({
          instanceUrl: c.public.instanceUrl,
          sandbox: c.public.sandbox,
          clientId: c.secrets.clientId,
          clientSecret: c.secrets.clientSecret,
        })
        return sf
      }),
      apollo: () => memo(organizationId, 'apollo', async () => {
        const c = await deps.load(organizationId, 'apollo')
        if (!c) return null
        const ap = new ApolloConnector()
        await ap.connect({ apiKey: c.secrets.apiKey })
        return ap
      }),
    }
  }
}

export const getConnectors = createConnectorFactory()

/**
 * Webhook signature lookup: HubSpot portal → { organizationId, webhookSecret }.
 * null when no workspace has connected this portal.
 */
export async function resolveHubspotPortal(
  portalId: string,
  deps: { findOrg: typeof findOrgByHubspotPortal; load: typeof loadConnectorCredentials } = {
    findOrg: findOrgByHubspotPortal, load: loadConnectorCredentials,
  },
): Promise<{ organizationId: string; webhookSecret: string } | null> {
  const organizationId = await deps.findOrg(portalId)
  if (!organizationId) return null
  const creds = await deps.load(organizationId, 'hubspot')
  if (!creds?.secrets.webhookSecret) return null
  return { organizationId, webhookSecret: creds.secrets.webhookSecret }
}
