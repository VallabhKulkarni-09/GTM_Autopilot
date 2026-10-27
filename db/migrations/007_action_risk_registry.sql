-- Migration: 007_action_risk_registry.sql
-- Description: Defines the risk profile for each action type.
--              ActionExecutor checks this before executing any action.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TYPE risk_level AS ENUM (
  'low',
  'medium',
  'high',
  'critical'
);

CREATE TABLE action_risk_registry (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_type              VARCHAR(100) NOT NULL,         -- e.g. 'assign_owner', 'enroll_sequence'
  risk_level               risk_level NOT NULL DEFAULT 'low',
  max_risk_score           NUMERIC(4,3) NOT NULL DEFAULT 1.000 CHECK (max_risk_score BETWEEN 0 AND 1),
  requires_human_review    BOOLEAN NOT NULL DEFAULT FALSE,
  required_policy_ids      UUID[],                        -- policy rules that must pass
  description              TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_action_risk_registry_action_type
    UNIQUE (organization_id, action_type)
);

CREATE INDEX idx_action_risk_registry_organization_id ON action_risk_registry(organization_id);
CREATE INDEX idx_action_risk_registry_action_type     ON action_risk_registry(organization_id, action_type);

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_action_risk_registry_action_type;
-- DROP INDEX IF EXISTS idx_action_risk_registry_organization_id;
-- DROP TABLE IF EXISTS action_risk_registry;
-- DROP TYPE IF EXISTS risk_level;
