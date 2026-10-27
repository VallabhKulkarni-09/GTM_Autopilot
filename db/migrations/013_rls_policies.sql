-- Migration: 013_rls_policies.sql
-- Description: Row-Level Security policies for all tables.
--              Every tenant can only access rows where organization_id matches their JWT claim.
--              Cross-tenant access returns 0 rows (not an error — security through obscurity).
-- Rollback: see bottom of file

-- FORWARD MIGRATION

-- Enable RLS on all tables
ALTER TABLE organizations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_identity     ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence              ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_rules          ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_risk_registry  ENABLE ROW LEVEL SECURITY;
ALTER TABLE play_instance         ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_execution_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_config      ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_state         ENABLE ROW LEVEL SECURITY;

-- ─── organizations ────────────────────────────────────────────────────────────
-- Users can only see their own organization
CREATE POLICY org_isolation ON organizations
  FOR ALL
  USING (id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── leads ────────────────────────────────────────────────────────────────────
CREATE POLICY leads_org_isolation ON leads
  FOR ALL
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── companies ────────────────────────────────────────────────────────────────
CREATE POLICY companies_org_isolation ON companies
  FOR ALL
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── external_identity ────────────────────────────────────────────────────────
CREATE POLICY external_identity_org_isolation ON external_identity
  FOR ALL
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── evidence ─────────────────────────────────────────────────────────────────
CREATE POLICY evidence_org_isolation ON evidence
  FOR ALL
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── policy_rules ─────────────────────────────────────────────────────────────
CREATE POLICY policy_rules_org_isolation ON policy_rules
  FOR ALL
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── action_risk_registry ─────────────────────────────────────────────────────
CREATE POLICY action_risk_registry_org_isolation ON action_risk_registry
  FOR ALL
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── play_instance ────────────────────────────────────────────────────────────
CREATE POLICY play_instance_org_isolation ON play_instance
  FOR ALL
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── event_log ────────────────────────────────────────────────────────────────
-- event_log: authenticated users can read, only service role can insert (immutability enforced at app layer too)
CREATE POLICY event_log_org_read ON event_log
  FOR SELECT
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

CREATE POLICY event_log_service_insert ON event_log
  FOR INSERT
  WITH CHECK (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- Explicitly NO UPDATE or DELETE policy on event_log — immutability enforced at DB level

-- ─── action_execution_state ───────────────────────────────────────────────────
CREATE POLICY action_execution_state_org_isolation ON action_execution_state
  FOR ALL
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── connector_config ─────────────────────────────────────────────────────────
CREATE POLICY connector_config_org_isolation ON connector_config
  FOR ALL
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── routing_state ────────────────────────────────────────────────────────────
CREATE POLICY routing_state_org_isolation ON routing_state
  FOR ALL
  USING (organization_id = (auth.jwt() ->> 'organization_id')::UUID);

-- ─── Service role bypass (for backend API using service key) ──────────────────
-- The Fastify API connects with SUPABASE_SERVICE_KEY which bypasses RLS.
-- RLS policies here protect direct Supabase client access (e.g., from dashboard or external tools).

-- ROLLBACK
-- ALTER TABLE routing_state         DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE connector_config      DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE action_execution_state DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE event_log             DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE play_instance         DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE action_risk_registry  DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE policy_rules          DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE evidence              DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE external_identity     DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE companies             DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE leads                 DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE organizations         DISABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS routing_state_org_isolation ON routing_state;
-- DROP POLICY IF EXISTS connector_config_org_isolation ON connector_config;
-- DROP POLICY IF EXISTS action_execution_state_org_isolation ON action_execution_state;
-- DROP POLICY IF EXISTS event_log_service_insert ON event_log;
-- DROP POLICY IF EXISTS event_log_org_read ON event_log;
-- DROP POLICY IF EXISTS play_instance_org_isolation ON play_instance;
-- DROP POLICY IF EXISTS action_risk_registry_org_isolation ON action_risk_registry;
-- DROP POLICY IF EXISTS policy_rules_org_isolation ON policy_rules;
-- DROP POLICY IF EXISTS evidence_org_isolation ON evidence;
-- DROP POLICY IF EXISTS external_identity_org_isolation ON external_identity;
-- DROP POLICY IF EXISTS companies_org_isolation ON companies;
-- DROP POLICY IF EXISTS leads_org_isolation ON leads;
-- DROP POLICY IF EXISTS org_isolation ON organizations;
