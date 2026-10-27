-- Migration: 001_organizations.sql
-- Description: Root entity. Every other table references this via organization_id.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE organizations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(255) NOT NULL,
  slug         VARCHAR(100) NOT NULL UNIQUE,
  domain       VARCHAR(255),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organizations_slug   ON organizations(slug);
CREATE INDEX idx_organizations_domain ON organizations(domain);

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_organizations_domain;
-- DROP INDEX IF EXISTS idx_organizations_slug;
-- DROP TABLE IF EXISTS organizations;
