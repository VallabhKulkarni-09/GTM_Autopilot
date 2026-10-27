/**
 * ai-model.repository.ts — the workspace's AI model connection (table ai_model_config, migration 033).
 * Queries only, every query scoped by organization_id. The API key is stored encrypted and only
 * decrypted here for building a model client; describeAiModel() never returns it.
 */
import { getDb } from '../db/client.js'
import { encryptJson, decryptJson } from '../connectors/crypto.js'
import type { ModelProvider } from '../models/types.js'

export type AiModelRow = {
  provider: ModelProvider
  base_url: string | null
  model: string
  has_api_key: boolean
  data_consent_at: string | null
  data_consent_by: string | null
  last_test_ok: boolean | null
  last_test_at: string | null
  qualification_agent_enabled: boolean
  qualification_evaluation_id: string | null
  routing_agent_enabled: boolean
  routing_evaluation_id: string | null
  updated_at: string
}

export type SaveAiModel = {
  provider: ModelProvider
  baseUrl: string | null
  model: string
  apiKey: string | null
  consentBy: string | null    // user id; required by the DB for cloud providers
  testOk: boolean
  resetAgents: boolean        // true when provider/model/address changed → agents off until re-tested
}

const PUBLIC_COLS = 'provider, base_url, model, secrets, data_consent_at, data_consent_by, last_test_ok, last_test_at, qualification_agent_enabled, qualification_evaluation_id, routing_agent_enabled, routing_evaluation_id, updated_at'

export async function describeAiModel(organizationId: string): Promise<AiModelRow | null> {
  const { data, error } = await getDb().from('ai_model_config').select(PUBLIC_COLS)
    .eq('organization_id', organizationId).maybeSingle()
  if (error) throw new Error(`describeAiModel failed: ${error.message}`)
  if (!data) return null
  const { secrets, ...rest } = data as Record<string, unknown>
  return { ...(rest as Omit<AiModelRow, 'has_api_key'>), has_api_key: typeof secrets === 'string' }
}

/** Decrypted config for building a client, or null when the workspace has none. */
export async function loadAiModel(organizationId: string): Promise<(AiModelRow & { apiKey: string | null }) | null> {
  const { data, error } = await getDb().from('ai_model_config').select(PUBLIC_COLS)
    .eq('organization_id', organizationId).maybeSingle()
  if (error) throw new Error(`loadAiModel failed: ${error.message}`)
  if (!data) return null
  const { secrets, ...rest } = data as Record<string, unknown>
  const apiKey = typeof secrets === 'string' ? decryptJson<{ apiKey: string }>(secrets).apiKey : null
  return { ...(rest as Omit<AiModelRow, 'has_api_key'>), has_api_key: apiKey !== null, apiKey }
}

export async function saveAiModel(organizationId: string, s: SaveAiModel): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await getDb().from('ai_model_config').upsert({
    organization_id: organizationId,
    provider: s.provider,
    base_url: s.baseUrl,
    model: s.model,
    secrets: s.apiKey ? encryptJson({ apiKey: s.apiKey }) : null,
    data_consent_at: s.consentBy ? now : null,
    data_consent_by: s.consentBy,
    last_test_ok: s.testOk,
    last_test_at: now,
    ...(s.resetAgents ? { qualification_agent_enabled: false, qualification_evaluation_id: null, routing_agent_enabled: false, routing_evaluation_id: null } : {}),
    updated_at: now,
  }, { onConflict: 'organization_id' })
  if (error) throw new Error(`saveAiModel failed: ${error.message}`)
}

export async function deleteAiModel(organizationId: string): Promise<void> {
  const { error } = await getDb().from('ai_model_config').delete().eq('organization_id', organizationId)
  if (error) throw new Error(`deleteAiModel failed: ${error.message}`)
}
