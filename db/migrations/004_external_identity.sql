-- Migration: 004_external_identity.sql
-- Description: Maps canonical leads/companies to their provider-specific IDs.
--              Salesforce ID, HubSpot ID, Outreach ID, Clearbit ID all live here — never on leads/companies.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TYPE external_provider AS ENUM (
  'salesforce',
  'hubspot',
  'outreach',
  'clearbit'
);

CREATE TYPE external_entity_type AS ENUM (
  'lead',
  'company'
);

CREATE TABLE external_identity (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type      external_entity_type NOT NULL,
  entity_id        UUID NOT NULL,                        -- our internal lead or company UUID
  provider         external_provider NOT NULL,
  external_id      VARCHAR(255) NOT NULL,                -- the provider's ID string
  metadata         JSONB,                                -- any additional provider-specific metadata
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One provider ID per entity per provider
  CONSTRAINT uq_external_identity_entity_provider
    UNIQUE (organization_id, entity_type, entity_id, provider)
);

CREATE INDEX idx_external_identity_organization_id ON external_identity(organization_id);
CREATE INDEX idx_external_identity_entity          ON external_identity(organization_id, entity_type, entity_id);
CREATE INDEX idx_external_identity_lookup          ON external_identity(organization_id, provider, external_id);

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_external_identity_lookup;
-- DROP INDEX IF EXISTS idx_external_identity_entity;
-- DROP INDEX IF EXISTS idx_external_identity_organization_id;
-- DROP TABLE IF EXISTS external_identity;
-- DROP TYPE IF EXISTS external_entity_type;
-- DROP TYPE IF EXISTS external_provider;
