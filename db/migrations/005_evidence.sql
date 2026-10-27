-- Migration: 005_evidence.sql
-- Description: Enrichment results, CRM facts, and intent signals attached to leads/companies.
--              Every piece of data that informed an agent decision is stored here.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TYPE evidence_source_type AS ENUM (
  'clearbit_person',
  'clearbit_company',
  'hubspot_contact',
  'salesforce_lead',
  'salesforce_contact',
  'intent_signal',
  'manual'
);

CREATE TABLE evidence (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id          UUID REFERENCES leads(id) ON DELETE CASCADE,
  company_id       UUID REFERENCES companies(id) ON DELETE SET NULL,
  source_type      evidence_source_type NOT NULL,
  source_id        VARCHAR(255),                   -- external record ID from the source
  data             JSONB NOT NULL,                 -- full enrichment payload
  is_current       BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE when superseded by newer evidence
  collected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ,                    -- NULL = never expires
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_evidence_organization_id ON evidence(organization_id);
CREATE INDEX idx_evidence_lead_id         ON evidence(organization_id, lead_id);
CREATE INDEX idx_evidence_company_id      ON evidence(organization_id, company_id);
CREATE INDEX idx_evidence_source_type     ON evidence(organization_id, source_type);
CREATE INDEX idx_evidence_is_current      ON evidence(organization_id, lead_id, is_current) WHERE is_current = TRUE;

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_evidence_is_current;
-- DROP INDEX IF EXISTS idx_evidence_source_type;
-- DROP INDEX IF EXISTS idx_evidence_company_id;
-- DROP INDEX IF EXISTS idx_evidence_lead_id;
-- DROP INDEX IF EXISTS idx_evidence_organization_id;
-- DROP TABLE IF EXISTS evidence;
-- DROP TYPE IF EXISTS evidence_source_type;
