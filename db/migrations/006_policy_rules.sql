-- Migration: 006_policy_rules.sql
-- Description: Territory, SLA, dedup, ICP filter, and routing rules per organization.
--              Versioned — changing a rule creates a new version (old version preserved for audit).
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TYPE policy_rule_type AS ENUM (
  'icp_filter',
  'territory',
  'sla',
  'dedup',
  'routing'
);

CREATE TABLE policy_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_type        policy_rule_type NOT NULL,
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  priority         INTEGER NOT NULL DEFAULT 100,          -- lower number = higher priority
  conditions       JSONB NOT NULL,                        -- rule conditions/thresholds
  actions          JSONB,                                 -- optional: what to do when rule fires
  effective_from   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until  TIMESTAMPTZ,                           -- NULL = no expiry
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_policy_rules_organization_id ON policy_rules(organization_id);
CREATE INDEX idx_policy_rules_type_active     ON policy_rules(organization_id, rule_type, is_active);
CREATE INDEX idx_policy_rules_priority        ON policy_rules(organization_id, rule_type, priority) WHERE is_active = TRUE;

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_policy_rules_priority;
-- DROP INDEX IF EXISTS idx_policy_rules_type_active;
-- DROP INDEX IF EXISTS idx_policy_rules_organization_id;
-- DROP TABLE IF EXISTS policy_rules;
-- DROP TYPE IF EXISTS policy_rule_type;
