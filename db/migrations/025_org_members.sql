-- Migration: 025_org_members.sql
-- Description: Workspace membership for Supabase Auth users (admin | member),
--              plus organizations.setup_completed_at for the setup wizard.
-- Rollback: see bottom of file

-- FORWARD MIGRATION
CREATE TYPE org_member_role AS ENUM ('admin', 'member');

CREATE TABLE org_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,          -- auth.users.id (Supabase Auth)
  email           VARCHAR(320) NOT NULL,  -- denormalised for the Team page
  role            org_member_role NOT NULL DEFAULT 'member',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX idx_org_members_user_id         ON org_members(user_id);
CREATE INDEX idx_org_members_organization_id ON org_members(organization_id);

-- Server uses the service role (bypasses RLS). Deny everything else by default.
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS setup_completed_at TIMESTAMPTZ;

-- ROLLBACK
-- ALTER TABLE organizations DROP COLUMN IF EXISTS setup_completed_at;
-- DROP TABLE IF EXISTS org_members;
-- DROP TYPE IF EXISTS org_member_role;
