-- Migration: 003_companies.sql
-- Description: Canonical company entity. Enriched from Clearbit. No provider IDs here.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TABLE companies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             VARCHAR(255),
  domain           VARCHAR(255),
  industry         VARCHAR(255),
  sub_industry     VARCHAR(255),
  employee_count   INTEGER,
  employee_range   VARCHAR(50),                  -- e.g. '51-200'
  annual_revenue   BIGINT,                       -- USD cents
  country          VARCHAR(100),
  state            VARCHAR(100),
  city             VARCHAR(100),
  founded_year     INTEGER,
  tech_stack       TEXT[],                       -- from Clearbit
  funding_stage    VARCHAR(100),
  raw_clearbit     JSONB,                        -- full Clearbit company payload
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_companies_organization_id ON companies(organization_id);
CREATE INDEX idx_companies_domain          ON companies(organization_id, domain);
CREATE INDEX idx_companies_country         ON companies(organization_id, country);
CREATE INDEX idx_companies_industry        ON companies(organization_id, industry);

-- Add FK from leads.company_id → companies.id now that companies table exists
ALTER TABLE leads
  ADD CONSTRAINT fk_leads_company_id
  FOREIGN KEY (company_id)
  REFERENCES companies(id)
  ON DELETE SET NULL;

-- ROLLBACK
-- ALTER TABLE leads DROP CONSTRAINT IF EXISTS fk_leads_company_id;
-- DROP INDEX IF EXISTS idx_companies_industry;
-- DROP INDEX IF EXISTS idx_companies_country;
-- DROP INDEX IF EXISTS idx_companies_domain;
-- DROP INDEX IF EXISTS idx_companies_organization_id;
-- DROP TABLE IF EXISTS companies;
