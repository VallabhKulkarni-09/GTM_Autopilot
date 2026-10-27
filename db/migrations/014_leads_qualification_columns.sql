-- Migration: 014_leads_qualification_columns.sql
-- Description: Adds ICP qualification fields and deduplication flag to leads table.
--              Required by QualificationAgent, ActionExecutor (qualify_lead action),
--              and the deduplication check in validate.ts.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS is_duplicate  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_icp_fit    BOOLEAN,
  ADD COLUMN IF NOT EXISTS icp_score     SMALLINT,
  ADD COLUMN IF NOT EXISTS icp_tier      VARCHAR(20);

-- Index for dedup lookups (isDuplicate query)
CREATE INDEX IF NOT EXISTS idx_leads_email_not_duplicate
  ON leads (organization_id, email)
  WHERE is_duplicate = FALSE;

-- Index for ICP filtering in dashboards
CREATE INDEX IF NOT EXISTS idx_leads_icp_tier
  ON leads (organization_id, icp_tier)
  WHERE icp_tier IS NOT NULL;

COMMENT ON COLUMN leads.is_duplicate IS 'True if this lead was detected as a duplicate of an existing lead in the same org.';
COMMENT ON COLUMN leads.is_icp_fit   IS 'True if QualificationAgent determined this lead matches ICP criteria.';
COMMENT ON COLUMN leads.icp_score    IS 'Numeric ICP score 0–100 assigned by QualificationAgent v1.';
COMMENT ON COLUMN leads.icp_tier     IS 'ICP tier: tier_1 (>=70), tier_2 (45–69), or not_icp (<45).';

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_leads_icp_tier;
-- DROP INDEX IF EXISTS idx_leads_email_not_duplicate;
-- ALTER TABLE leads
--   DROP COLUMN IF EXISTS icp_tier,
--   DROP COLUMN IF EXISTS icp_score,
--   DROP COLUMN IF EXISTS is_icp_fit,
--   DROP COLUMN IF EXISTS is_duplicate;
