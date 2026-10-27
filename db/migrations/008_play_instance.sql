-- Migration: 008_play_instance.sql
-- Description: One play instance per lead going through a GTM play.
--              Tracks SLA deadline (derived from form_submitted_at, never created_at).
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TYPE play_status AS ENUM (
  'running',
  'completed',
  'failed',
  'paused',
  'nurture',
  'duplicate'
);

CREATE TABLE play_instance (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id               UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  play_type             VARCHAR(100) NOT NULL DEFAULT 'high_intent_inbound',
  status                play_status NOT NULL DEFAULT 'running',
  workflow_run_id       VARCHAR(255),                          -- LangGraph run ID
  current_step          INTEGER NOT NULL DEFAULT 0,

  -- SLA fields — deadline always based on form_submitted_at, never system time
  first_touch_deadline  TIMESTAMPTZ NOT NULL,                  -- form_submitted_at + sla_minutes
  first_touch_at        TIMESTAMPTZ,                           -- when first outreach actually happened
  sla_breached          BOOLEAN NOT NULL DEFAULT FALSE,
  sla_breached_at       TIMESTAMPTZ,

  -- Outcome tracking
  assigned_owner_id     VARCHAR(255),                          -- Salesforce user ID
  assigned_owner_name   VARCHAR(255),
  sequence_id           VARCHAR(255),                          -- Outreach sequence ID
  enrolled_at           TIMESTAMPTZ,

  -- Error info (set when status = 'failed')
  failure_reason        TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_play_instance_organization_id     ON play_instance(organization_id);
CREATE INDEX idx_play_instance_lead_id             ON play_instance(organization_id, lead_id);
CREATE INDEX idx_play_instance_status              ON play_instance(organization_id, status);
CREATE INDEX idx_play_instance_sla_check           ON play_instance(organization_id, first_touch_deadline, sla_breached, status)
  WHERE status = 'running' AND sla_breached = FALSE;
CREATE INDEX idx_play_instance_workflow_run_id     ON play_instance(workflow_run_id) WHERE workflow_run_id IS NOT NULL;

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_play_instance_workflow_run_id;
-- DROP INDEX IF EXISTS idx_play_instance_sla_check;
-- DROP INDEX IF EXISTS idx_play_instance_status;
-- DROP INDEX IF EXISTS idx_play_instance_lead_id;
-- DROP INDEX IF EXISTS idx_play_instance_organization_id;
-- DROP TABLE IF EXISTS play_instance;
-- DROP TYPE IF EXISTS play_status;
