-- Migration: 023_reenrollment_policy.sql
-- Description: Seed a default re-enrollment policy row for each existing org.
--              The re-enrollment logic checks this row; if no row exists for an org,
--              it falls back to the hardcoded constant (90 days).
--
-- ASSUMPTION: The 90-day default has no empirical basis — it was chosen as a reasonable
--             placeholder before any customer data was available. Update this value once
--             real usage data shows the actual sales cycle length. See validate.ts.
--
-- This migration is idempotent (ON CONFLICT DO NOTHING).
-- Real orgs configure this via PUT /api/policies/:id.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM organizations LOOP
    INSERT INTO policy_rules (
      organization_id,
      rule_type,
      name,
      conditions,
      actions,
      priority,
      is_active
    ) VALUES (
      r.id,
      're_enrollment',
      'Default Re-enrollment Window',
      '{}',
      '{"allow_after_days": 90}',
      100,
      true
    )
    ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;

-- ROLLBACK
-- DELETE FROM policy_rules WHERE rule_type = 're_enrollment' AND name = 'Default Re-enrollment Window';
