-- Migration: 002_leads.sql
-- Description: Canonical lead entity. No provider-specific IDs here — those live in external_identity.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TYPE lead_stage AS ENUM (
  'new',
  'enriching',
  'routing',
  'in_sequence',
  'meeting_booked',
  'nurture',
  'lost'
);

CREATE TABLE leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email               VARCHAR(320) NOT NULL,
  first_name          VARCHAR(255),
  last_name           VARCHAR(255),
  title               VARCHAR(255),
  phone               VARCHAR(50),
  company_id          UUID,                                        -- set after enrichment, FK added in 003
  stage               lead_stage NOT NULL DEFAULT 'new',
  form_submitted_at   TIMESTAMPTZ NOT NULL,                        -- SLA clock starts here — NEVER null
  source              VARCHAR(100) NOT NULL DEFAULT 'hubspot',     -- originating system
  raw_payload         JSONB,                                       -- full original form payload
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leads_organization_id     ON leads(organization_id);
CREATE INDEX idx_leads_email               ON leads(organization_id, email);
CREATE INDEX idx_leads_stage               ON leads(organization_id, stage);
CREATE INDEX idx_leads_form_submitted_at   ON leads(organization_id, form_submitted_at);
CREATE INDEX idx_leads_company_id          ON leads(organization_id, company_id);

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_leads_company_id;
-- DROP INDEX IF EXISTS idx_leads_form_submitted_at;
-- DROP INDEX IF EXISTS idx_leads_stage;
-- DROP INDEX IF EXISTS idx_leads_email;
-- DROP INDEX IF EXISTS idx_leads_organization_id;
-- DROP TABLE IF EXISTS leads;
-- DROP TYPE IF EXISTS lead_stage;
