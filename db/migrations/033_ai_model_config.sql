-- Migration: 033_ai_model_config.sql
-- Description: Per-workspace AI model connection (v2 step 3). One row per workspace.
--   provider       ollama | openai_compatible (both local, base_url set by an admin)
--                  | openai | openrouter | anthropic (cloud, fixed base URL in code)
--   base_url       only for local providers; validated + SSRF-checked by the API
--   model          any model name the provider accepts (nothing hard-coded)
--   secrets        AES-256-GCM "v1:…" JSON { apiKey } (src/connectors/crypto.ts), NULL for keyless local
--   data_consent_* cloud providers only: who confirmed that lead data leaves the machine, and when
--   last_test_*    result of the last "Test connection"
-- Rollback: see bottom of file

-- FORWARD MIGRATION
CREATE TABLE IF NOT EXISTS ai_model_config (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id),
  provider           TEXT NOT NULL CHECK (provider IN ('ollama', 'openai_compatible', 'openai', 'openrouter', 'anthropic')),
  base_url           TEXT,
  model              TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  secrets            TEXT,
  data_consent_at    TIMESTAMPTZ,
  data_consent_by    UUID,
  last_test_ok       BOOLEAN,
  last_test_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT ai_model_config_org_unique UNIQUE (organization_id),
  CONSTRAINT ai_model_config_local_has_url CHECK (
    provider NOT IN ('ollama', 'openai_compatible') OR base_url IS NOT NULL
  ),
  CONSTRAINT ai_model_config_cloud_has_consent CHECK (
    provider IN ('ollama', 'openai_compatible') OR (data_consent_at IS NOT NULL AND data_consent_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_model_config_organization_id ON ai_model_config (organization_id);

-- Only the server (service key) reads this table.
ALTER TABLE ai_model_config ENABLE ROW LEVEL SECURITY;

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_ai_model_config_organization_id;
-- DROP TABLE IF EXISTS ai_model_config;
