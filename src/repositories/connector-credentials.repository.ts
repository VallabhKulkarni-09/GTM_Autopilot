/**
 * connector-credentials.repository.ts — encrypted, org-scoped connector credentials (v1).
 *
 * Row layout in connector_config.config:
 *   { ...public fields (plaintext, non-secret, queryable e.g. portal_id), _secrets: "v1:…" }
 * Secrets are only ever decrypted server-side for building connectors.
 * The API layer only receives `public` + a boolean per configured secret.
 */

import { getDb } from '../db/client.js'
import { encryptJson, decryptJson } from '../connectors/crypto.js'

export const V1_CONNECTORS = ['hubspot', 'salesforce', 'apollo'] as const
export type V1ConnectorName = typeof V1_CONNECTORS[number]

export type CredentialShapes = {
  hubspot:    { public: { portal_id: string }; secrets: { apiKey: string; webhookSecret: string } }
  salesforce: { public: { instanceUrl: string; sandbox: boolean }; secrets: { clientId: string; clientSecret: string } }
  apollo:     { public: Record<string, never>; secrets: { apiKey: string } }
}

export type StoredCredentials<N extends V1ConnectorName> = CredentialShapes[N]

export async function saveConnectorCredentials<N extends V1ConnectorName>(
  organizationId: string,
  name: N,
  creds: StoredCredentials<N>,
): Promise<void> {
  const config = { ...creds.public, _secrets: encryptJson(creds.secrets) }
  const { error } = await getDb()
    .from('connector_config')
    .upsert({
      organization_id: organizationId,
      connector_name: name,
      is_active: true,
      config,
      credentials_vault_key: `org:${organizationId}:connector:${name}:aes-gcm`,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,connector_name' })
  if (error) throw new Error(`saveConnectorCredentials failed: ${error.message}`)
}

/** Decrypted credentials, or null when this org has not connected `name` (or it is disabled). */
export async function loadConnectorCredentials<N extends V1ConnectorName>(
  organizationId: string,
  name: N,
): Promise<StoredCredentials<N> | null> {
  const { data, error } = await getDb()
    .from('connector_config')
    .select('config, is_active')
    .eq('organization_id', organizationId)
    .eq('connector_name', name)
    .maybeSingle()
  if (error) throw new Error(`loadConnectorCredentials failed: ${error.message}`)
  if (!data || !data.is_active) return null
  const { _secrets, ...publicFields } = (data.config ?? {}) as Record<string, unknown>
  if (typeof _secrets !== 'string') return null   // legacy plaintext row — must be re-saved / imported
  return { public: publicFields, secrets: decryptJson(_secrets) } as StoredCredentials<N>
}

/** Non-secret view for the API: never includes secret values. */
export async function describeConnector(organizationId: string, name: V1ConnectorName): Promise<{
  configured: boolean
  public: Record<string, unknown>
  healthStatus: string | null
  lastCheckedAt: string | null
}> {
  const { data, error } = await getDb()
    .from('connector_config')
    .select('config, is_active, health_status, last_health_check_at')
    .eq('organization_id', organizationId)
    .eq('connector_name', name)
    .maybeSingle()
  if (error) throw new Error(`describeConnector failed: ${error.message}`)
  const { _secrets, ...publicFields } = (data?.config ?? {}) as Record<string, unknown>
  return {
    configured: Boolean(data?.is_active && typeof _secrets === 'string'),
    public: publicFields,
    healthStatus: data?.health_status ?? null,
    lastCheckedAt: data?.last_health_check_at ?? null,
  }
}

export async function recordHealth(organizationId: string, name: V1ConnectorName, ok: boolean): Promise<void> {
  await getDb().from('connector_config')
    .update({ health_status: ok ? 'healthy' : 'error', last_health_check_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('connector_name', name)
}

/**
 * HubSpot portal → workspace. Used only by the webhook (no user session).
 * portal_id is unique per workspace by construction (Connections page refuses duplicates).
 */
export async function findOrgByHubspotPortal(portalId: string): Promise<string | null> {
  const { data, error } = await getDb()
    .from('connector_config')
    .select('organization_id')
    .eq('connector_name', 'hubspot')
    .eq('is_active', true)
    .contains('config', { portal_id: portalId })
    .limit(2)
  if (error) throw new Error(`findOrgByHubspotPortal failed: ${error.message}`)
  if (!data || data.length === 0) return null
  if (data.length > 1) throw new Error(`HubSpot portal ${portalId} is connected to more than one workspace`)
  return data[0].organization_id as string
}
