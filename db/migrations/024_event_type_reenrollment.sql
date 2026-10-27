-- Migration: 024_event_type_reenrollment.sql
-- Description: Add 'reenrollment_allowed' to the event_type enum.
--              This event is written by validate.ts when a returning lead passes
--              the time-window + terminal-status re-enrollment check.

ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'reenrollment_allowed';

-- Note: ADD VALUE IF NOT EXISTS is idempotent in Postgres 9.6+.
-- No rollback possible for enum additions in Postgres — coordinate with team before running.

-- ROLLBACK: not possible without recreating the enum type. Do not run this migration
-- in an environment where rollback is required.
