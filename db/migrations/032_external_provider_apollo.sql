-- Migration: 032_external_provider_apollo.sql
-- Description: Allow external_identity rows for Apollo (contact IDs from sequence enrollment).
--              Found live: enrollment succeeded but the Apollo contact mapping was dropped with
--              'invalid input value for enum external_provider: "apollo"'.
-- Rollback: enum values cannot be removed in Postgres; harmless to keep.

-- FORWARD MIGRATION
ALTER TYPE external_provider ADD VALUE IF NOT EXISTS 'apollo';

-- ROLLBACK
-- (not reversible — Postgres cannot drop an enum value)
