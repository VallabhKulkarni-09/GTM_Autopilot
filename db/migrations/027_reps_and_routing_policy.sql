-- Migration: 027_reps_and_routing_policy.sql
-- Description: Reps & territories (v1 Task 8).
--   1. Seed the "Lead assignment" routing policy (max_open_leads_per_rep = 25, the value
--      previously hard-coded in src/agents/routing/rules.ts) for every org without one.
--   2. Backfill rep flags on existing Salesforce user rows in external_identity:
--      metadata.available and metadata.sf_active are now read strictly by route.ts.
--      Existing rows were all routable before, so both are set to true where missing.
--   3. Territory rows now keep queue/reps in `actions` ({queue_name, owner_ids}).
--      Before this, routing read a non-existent column and always behaved as
--      queue "default" + every rep; rows missing queue_name get exactly that.
-- No enum change: 'routing' and 'territory' exist since 006; 'user' since 016.
-- Idempotent.
-- Rollback: see bottom of file

-- FORWARD MIGRATION
INSERT INTO policy_rules (organization_id, rule_type, name, description, conditions, actions, priority, is_active)
SELECT o.id, 'routing', 'Lead assignment',
       'The most open leads a rep can hold before new leads skip them.',
       '{}'::jsonb, '{"max_open_leads_per_rep": 25}'::jsonb, 40, true
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM policy_rules p
  WHERE p.organization_id = o.id AND p.rule_type = 'routing' AND p.is_active = true
);

UPDATE external_identity
SET metadata = COALESCE(metadata, '{}'::jsonb)
               || jsonb_build_object(
                    'available', COALESCE((metadata->>'available')::boolean, true),
                    'sf_active', COALESCE((metadata->>'sf_active')::boolean, true)),
    updated_at = NOW()
WHERE provider = 'salesforce' AND entity_type = 'user'
  AND (metadata IS NULL OR NOT (metadata ? 'available') OR NOT (metadata ? 'sf_active'));

UPDATE policy_rules
SET actions = COALESCE(actions, '{}'::jsonb) || '{"queue_name": "default", "owner_ids": null}'::jsonb,
    updated_at = NOW()
WHERE rule_type = 'territory'
  AND (actions IS NULL OR NOT (actions ? 'queue_name'));

-- ROLLBACK
-- DELETE FROM policy_rules WHERE rule_type = 'routing' AND name = 'Lead assignment';
-- (Metadata/actions backfills are additive keys; remove with `metadata - 'available' - 'sf_active'` if needed.)
