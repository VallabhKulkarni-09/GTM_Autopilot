-- Migration: 031_test_leads.sql
-- Description: Test leads for the setup wizard (v1 Task 12).
--   leads.is_test / play_instance.is_test
--     TRUE for leads sent from the setup page (POST /api/test-lead). They run the real
--     pipeline, but metrics exclude them and duplicate checks ignore them.
--     play_instance carries its own copy so metrics can filter without a join.
--   leads.removed_at / play_instance.removed_at
--     Set by DELETE /api/test-lead. Rows cannot be deleted: event_log references leads and
--     is append-only. Removed rows are hidden from lists, approvals, attention and the SLA timer.
-- Rollback: see bottom of file

-- FORWARD MIGRATION
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS is_test    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

ALTER TABLE play_instance
  ADD COLUMN IF NOT EXISTS is_test    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

-- Setup page: this org's test leads, newest first
CREATE INDEX IF NOT EXISTS idx_leads_organization_id_test
  ON leads (organization_id, form_submitted_at DESC)
  WHERE is_test = TRUE;

-- Metrics: real plays only
CREATE INDEX IF NOT EXISTS idx_play_instance_organization_id_created_at_real
  ON play_instance (organization_id, created_at)
  WHERE is_test = FALSE;

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_play_instance_organization_id_created_at_real;
-- DROP INDEX IF EXISTS idx_leads_organization_id_test;
-- ALTER TABLE play_instance DROP COLUMN IF EXISTS removed_at, DROP COLUMN IF EXISTS is_test;
-- ALTER TABLE leads DROP COLUMN IF EXISTS removed_at, DROP COLUMN IF EXISTS is_test;
