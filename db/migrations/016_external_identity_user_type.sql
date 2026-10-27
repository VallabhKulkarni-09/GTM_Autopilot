-- Migration: 016_external_identity_user_type.sql
-- Description: Extends external_entity_type enum to include 'user'.
--              Required for storing Salesforce users in external_identity
--              so RoutingAgent can load available owners from the DB.
--
-- Rollback: cannot remove enum values in Postgres without recreating the type.
--           To roll back, restore from backup or recreate the enum without 'user'.

-- FORWARD MIGRATION

ALTER TYPE external_entity_type ADD VALUE IF NOT EXISTS 'user';

COMMENT ON TYPE external_entity_type IS
  'Type of entity this external identity belongs to: lead, company, or user (e.g. Salesforce user / owner).';

-- ROLLBACK
-- Cannot remove enum values directly in PostgreSQL.
-- Rollback: pg_dump + restore is the only safe path.
