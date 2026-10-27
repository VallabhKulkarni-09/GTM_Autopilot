-- Migration: 021_policy_rule_type_reenrollment.sql
-- Description: Add 're_enrollment' to the policy_rule_type enum.
--              Required before migration 023 can insert a re_enrollment policy row.
--              Also adds 'outcome_detection' guard (idempotent — already added by 018,
--              but IF NOT EXISTS makes this safe to run on any env).
--
-- Note: ADD VALUE IF NOT EXISTS is idempotent in Postgres 9.6+.
-- No rollback possible for enum additions without recreating the type.

ALTER TYPE policy_rule_type ADD VALUE IF NOT EXISTS 're_enrollment';
