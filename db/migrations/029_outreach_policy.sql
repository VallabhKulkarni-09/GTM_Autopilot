-- Migration: 029_outreach_policy.sql
-- Description: Seed the "Outreach" policy (rule_type 'outreach') for every org without one.
--   Sequences and the sending mailbox are Apollo IDs that only the user can choose, so the
--   seed is explicitly "not set up yet" (null). Until an admin picks them on the Outreach
--   page, qualified leads are escalated with OUTREACH_TIER_NOT_SET — never silently skipped.
--   Shape: see src/policies/outreach-policy.ts.
-- Idempotent.
-- Rollback: see bottom of file

-- FORWARD MIGRATION
INSERT INTO policy_rules (organization_id, rule_type, name, description, conditions, actions, priority, is_active)
SELECT o.id, 'outreach', 'Outreach',
       'Which Apollo sequence each fit level goes into, and the mailbox that sends it.',
       '{}'::jsonb,
       '{"email_account": null, "tiers": {"tier_1": null, "tier_2": null}}'::jsonb,
       50, true
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM policy_rules p
  WHERE p.organization_id = o.id AND p.rule_type = 'outreach' AND p.is_active = true
);

-- ROLLBACK
-- DELETE FROM policy_rules WHERE rule_type = 'outreach' AND name = 'Outreach';
