-- Migration: 034_event_type_model_fallback.sql
-- Description: Add 'model_fallback' to event_type (v2 step 4). Written when the AI model's answer could not be
--              used (timeout, unreachable, invalid output, model changed since its test run) and the rules decided.
--              Runs outside a transaction (migrate-lib detects ADD VALUE).
-- Rollback: see bottom of file

-- FORWARD MIGRATION
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'model_fallback';

-- ROLLBACK
-- Not possible: Postgres cannot drop an enum value without recreating the type.
-- An unused 'model_fallback' value is harmless.
