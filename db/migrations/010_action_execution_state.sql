-- Migration: 010_action_execution_state.sql
-- Description: Mutable projection derived from event_log. Used by APIs and dashboards for fast queries.
--              Updated by event-processor.ts as events arrive. Never the source of truth.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TYPE action_execution_status AS ENUM (
  'proposed',
  'started',
  'succeeded',
  'failed',
  'deduplicated'
);

CREATE TABLE action_execution_state (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key   VARCHAR(500) NOT NULL,                  -- organizationId:workflowRunId:actionId
  play_instance_id  UUID REFERENCES play_instance(id),
  lead_id           UUID REFERENCES leads(id),
  action_type       VARCHAR(100) NOT NULL,
  status            action_execution_status NOT NULL DEFAULT 'proposed',

  -- Timing
  proposed_at       TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,

  -- Result
  external_system   VARCHAR(100),
  external_id       VARCHAR(255),                           -- ID returned from external system
  error_code        VARCHAR(100),
  error_message     TEXT,

  -- Metadata
  agent_name        VARCHAR(100),
  agent_version     VARCHAR(50),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_action_execution_state_idempotency_key
    UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX idx_action_execution_state_organization_id ON action_execution_state(organization_id);
CREATE INDEX idx_action_execution_state_lead_id         ON action_execution_state(organization_id, lead_id);
CREATE INDEX idx_action_execution_state_play_instance   ON action_execution_state(organization_id, play_instance_id);
CREATE INDEX idx_action_execution_state_status          ON action_execution_state(organization_id, status);
CREATE INDEX idx_action_execution_state_idempotency_key ON action_execution_state(idempotency_key);

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_action_execution_state_idempotency_key;
-- DROP INDEX IF EXISTS idx_action_execution_state_status;
-- DROP INDEX IF EXISTS idx_action_execution_state_play_instance;
-- DROP INDEX IF EXISTS idx_action_execution_state_lead_id;
-- DROP INDEX IF EXISTS idx_action_execution_state_organization_id;
-- DROP TABLE IF EXISTS action_execution_state;
-- DROP TYPE IF EXISTS action_execution_status;
