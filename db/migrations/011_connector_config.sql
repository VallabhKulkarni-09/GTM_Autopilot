-- Migration: 011_connector_config.sql
-- Description: Encrypted API credentials per organization per connector.
--              The actual credential values are stored in Supabase Vault.
--              This table only stores the vault key reference + health status.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TYPE connector_name AS ENUM (
  'salesforce',
  'hubspot',
  'outreach',
  'clearbit'
);

CREATE TYPE connector_health_status AS ENUM (
  'healthy',
  'degraded',
  'unhealthy',
  'unknown'
);

CREATE TABLE connector_config (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connector_name         connector_name NOT NULL,
  is_active              BOOLEAN NOT NULL DEFAULT FALSE,
  credentials_vault_key  VARCHAR(500) NOT NULL,             -- Supabase Vault secret reference
  config                 JSONB,                             -- non-secret config (e.g. sandbox flag)

  -- Health tracking
  last_health_check_at   TIMESTAMPTZ,
  health_status          connector_health_status NOT NULL DEFAULT 'unknown',
  health_latency_ms      INTEGER,
  health_error           TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_connector_config_org_connector
    UNIQUE (organization_id, connector_name)
);

CREATE INDEX idx_connector_config_organization_id ON connector_config(organization_id);
CREATE INDEX idx_connector_config_name_active     ON connector_config(organization_id, connector_name, is_active);

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_connector_config_name_active;
-- DROP INDEX IF EXISTS idx_connector_config_organization_id;
-- DROP TABLE IF EXISTS connector_config;
-- DROP TYPE IF EXISTS connector_health_status;
-- DROP TYPE IF EXISTS connector_name;
