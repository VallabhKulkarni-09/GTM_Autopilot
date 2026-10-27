-- Migration: 028_policy_rule_type_outreach.sql
-- Description: Add 'outreach' to the policy_rule_type enum (v1 Task 9: Apollo Sequences).
--              Required before 029 can insert the outreach policy rows.
--              Runs outside a transaction (migrate-lib detects ADD VALUE).
-- Rollback: see bottom of file

-- FORWARD MIGRATION
ALTER TYPE policy_rule_type ADD VALUE IF NOT EXISTS 'outreach';

-- ROLLBACK
-- Not possible: Postgres cannot drop an enum value without recreating the type.
-- An unused 'outreach' value is harmless.
