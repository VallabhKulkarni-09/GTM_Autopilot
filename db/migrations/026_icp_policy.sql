-- Migration: 026_icp_policy.sql
-- Description: Seed the "Ideal customer" policy (rule_type = 'icp_filter') for every existing org.
--              Values are identical to the rules previously hard-coded in
--              src/agents/qualification/rules.ts (see DEFAULT_ICP_CONFIG in icp-config.ts).
--              New workspaces get the same row from seedDefaultPolicies().
--
-- No enum change: 'icp_filter' exists since 006.
-- Before this migration, icp_filter rows were never read by qualification. Any pre-existing
-- row without the v1 shape (no "tier_thresholds" key) is deactivated so it cannot be picked up
-- and fail validation; it is kept (not deleted) for audit.
--
-- Idempotent: only inserts for orgs with no active v1-shaped icp_filter row.
-- Rollback: see bottom of file

-- FORWARD MIGRATION
UPDATE policy_rules
SET is_active = false, updated_at = NOW()
WHERE rule_type = 'icp_filter'
  AND is_active = true
  AND NOT (conditions ? 'tier_thresholds');

INSERT INTO policy_rules (organization_id, rule_type, name, description, conditions, actions, priority, is_active)
SELECT
  o.id,
  'icp_filter',
  'Ideal customer',
  'Which companies and people are a good fit, and how fit is scored.',
  '{
    "industries": ["saas", "software", "technology"],
    "countries": ["US", "CA", "GB", "DE", "AU", "NL"],
    "employee_floor": 10,
    "employee_near_min": 50,
    "employee_min": 100,
    "employee_max": 1000,
    "title_keywords": ["vp", "vice president", "director", "head", "chief", "cto", "ceo", "coo", "cfo", "founder"],
    "intent_keywords": ["demo", "trial"],
    "block_free_email": true,
    "weights": {"company_size": 30, "company_size_near": 15, "company_size_large": 20, "industry": 25, "country": 20, "intent": 15, "title": 10},
    "tier_thresholds": {"tier_1": 70, "tier_2": 45}
  }'::jsonb,
  NULL,
  30,
  true
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM policy_rules p
  WHERE p.organization_id = o.id AND p.rule_type = 'icp_filter' AND p.is_active = true
);

-- ROLLBACK
-- DELETE FROM policy_rules WHERE rule_type = 'icp_filter' AND name = 'Ideal customer';
