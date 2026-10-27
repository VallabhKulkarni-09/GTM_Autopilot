-- 019_add_connectors.sql
-- Adds salesloft and zoominfo to connector_name enum.
-- connector_config.config JSONB is already present and RLS-protected per org —
-- OAuth tokens for all connectors are stored there for MVP.
-- Supabase Vault integration is planned for production.

BEGIN;

ALTER TYPE connector_name ADD VALUE IF NOT EXISTS 'salesloft';
ALTER TYPE connector_name ADD VALUE IF NOT EXISTS 'zoominfo';

COMMENT ON COLUMN connector_config.config IS
  'Non-secret connector config JSONB. OAuth tokens for outreach/salesloft stored here
   (access_token, refresh_token, expires_at). ZoomInfo JWT stored here.
   RLS policy connector_config_org_isolation (organization_id = jwt org) enforces
   tenant isolation at the DB level — no cross-org reads are possible.
   Supabase Vault integration is planned for production; JSONB is used for MVP.';

COMMIT;
