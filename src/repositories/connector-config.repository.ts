/**
 * connector-config.repository.ts
 * Typed repository for reading and writing connector_config rows.
 *
 * CRITICAL: Every query MUST be scoped to organizationId.
 * A cross-tenant read of connector tokens is existential — never query without org scope.
 *
 * Token storage strategy (MVP):
 *   OAuth tokens (access_token, refresh_token, expires_at) are stored in
 *   connector_config.config JSONB. The RLS policy connector_config_org_isolation
 *   ensures reads are always scoped to the requesting org's JWT. This is the
 *   security boundary for token isolation.
 *
 * credentials_vault_key column exists for future Supabase Vault integration
 * (production target). For MVP, set to a placeholder value.
 */

import { getDb } from '../db/client.js'
import type { ConnectorName } from '../domain/db-types.js'

export type ConnectorConfigRow = {
  id:             string
  organization_id: string
  connector_name: ConnectorName
  is_active:      boolean
  config:         Record<string, unknown> | null
  health_status:  string
  last_health_check_at: string | null
}

export type OAuthTokens = {
  access_token:  string
  refresh_token: string
  expires_at:    number    // epoch ms
  scope?:        string
}

export type ZoomInfoCredentials = {
  username: string
  password: string
}

/**
 * Retrieves the connector config for a specific org + connector.
 * Returns null when no row exists (connector not yet configured for this org).
 * Always scoped to organizationId — never omit this parameter.
 */
export async function getConnectorConfig(
  organizationId: string,
  connectorName: ConnectorName
): Promise<ConnectorConfigRow | null> {
  const { data, error } = await getDb()
    .from('connector_config')
    .select('id, organization_id, connector_name, is_active, config, health_status, last_health_check_at')
    .eq('organization_id', organizationId)
    .eq('connector_name', connectorName)
    .single()

  if (error?.code === 'PGRST116') return null  // no rows — not an error
  if (error) throw new Error(`connector_config read failed: ${error.message}`)
  return data as ConnectorConfigRow
}

/**
 * Upserts connector config for an org.
 * Merges the provided config fields into the existing JSONB config.
 * Creates the row if it doesn't exist.
 * Always scoped to organizationId.
 */
export async function upsertConnectorConfig(
  organizationId: string,
  connectorName: ConnectorName,
  config: Record<string, unknown>,
  isActive = true
): Promise<void> {
  const { error } = await getDb()
    .from('connector_config')
    .upsert(
      {
        organization_id:      organizationId,
        connector_name:       connectorName,
        is_active:            isActive,
        config,
        credentials_vault_key: `org:${organizationId}:connector:${connectorName}:mvp`,
        updated_at:           new Date().toISOString(),
      },
      { onConflict: 'organization_id,connector_name' }
    )
  if (error) throw new Error(`connector_config upsert failed: ${error.message}`)
}

/**
 * Reads OAuth tokens from connector_config for a given org + connector.
 * Returns null when not configured. Never returns tokens from another org.
 */
export async function getOAuthTokens(
  organizationId: string,
  connectorName: ConnectorName
): Promise<OAuthTokens | null> {
  const row = await getConnectorConfig(organizationId, connectorName)
  if (!row?.config) return null
  const { access_token, refresh_token, expires_at, scope } = row.config as any
  if (!access_token || !refresh_token) return null
  return { access_token, refresh_token, expires_at: expires_at ?? 0, scope }
}

/**
 * Stores OAuth tokens for an org's connector.
 * Called by OAuth callback routes after successful token exchange.
 * Always scoped to organizationId.
 */
export async function storeOAuthTokens(
  organizationId: string,
  connectorName: ConnectorName,
  tokens: OAuthTokens
): Promise<void> {
  // Read existing config to preserve non-token fields (e.g. mailboxId, sequenceId)
  const existing = await getConnectorConfig(organizationId, connectorName)
  const existingConfig = existing?.config ?? {}

  await upsertConnectorConfig(organizationId, connectorName, {
    ...existingConfig,
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    tokens.expires_at,
    scope:         tokens.scope ?? existingConfig.scope,
  })
}
