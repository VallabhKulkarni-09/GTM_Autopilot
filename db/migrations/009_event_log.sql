-- Migration: 009_event_log.sql
-- Description: IMMUTABLE append-only event log. Source of truth for everything.
--              NO updated_at column — ever. INSERT only, no UPDATE, no DELETE.
--              decision_snapshot JSONB NOT NULL on every row.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TYPE event_type AS ENUM (
  -- Ingestion
  'webhook_received',
  'idempotency_check_passed',
  'idempotency_check_failed',

  -- Enrichment
  'enrichment_requested',
  'enrichment_succeeded',
  'enrichment_failed',
  'enrichment_skipped',

  -- Deduplication
  'dedup_passed',
  'dedup_rejected',

  -- Agent decisions
  'action_proposed',
  'action_risk_assessed',
  'policy_validated',
  'policy_rejected',

  -- Execution
  'action_execution_started',
  'action_execution_succeeded',
  'action_execution_failed',
  'action_execution_deduplicated',

  -- SLA
  'sla_checked',
  'sla_breached',
  'escalation_triggered',
  'escalation_sent',

  -- Human in the loop
  'human_review_requested',
  'human_approved',
  'human_rejected',

  -- Play lifecycle
  'play_completed',
  'play_failed',
  'play_paused',
  'play_resumed',
  'play_marked_nurture',
  'play_marked_duplicate'
);

CREATE TYPE actor_type AS ENUM (
  'agent',
  'human',
  'system',
  'sla_timer',
  'webhook'
);

CREATE TYPE event_status AS ENUM (
  'success',
  'failed',
  'skipped'
);

CREATE TABLE event_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id),   -- no CASCADE — events are permanent
  workflow_run_id    VARCHAR(255),
  play_instance_id   UUID REFERENCES play_instance(id),
  lead_id            UUID REFERENCES leads(id),

  -- Event classification
  event_type         event_type NOT NULL,
  actor_type         actor_type NOT NULL,
  actor_id           VARCHAR(255),                                 -- agent name, user ID, etc.
  agent_version      VARCHAR(50),
  model_provider     VARCHAR(100),
  model_name         VARCHAR(100),
  prompt_version     VARCHAR(50),

  -- The sacred snapshot — enables full replay and simulation
  -- Contains: lead, company, policies (with versions), ownerWorkloads,
  --           evidenceIds, agentName, agentVersion, promptVersion, modelName
  decision_snapshot  JSONB NOT NULL,                               -- NEVER NULL. NEVER OPTIONAL.

  -- Action data
  proposed_action    JSONB,
  candidate_actions  JSONB,

  -- Policy data
  policy_rule_id     UUID REFERENCES policy_rules(id),
  policy_name        VARCHAR(255),
  policy_passed      BOOLEAN,
  policy_decision    JSONB,

  -- External system data
  external_system    VARCHAR(100),                                 -- 'salesforce', 'hubspot', etc.
  external_id        VARCHAR(255),
  idempotency_key    VARCHAR(500),

  -- Outcome
  event_status       event_status NOT NULL,
  error_code         VARCHAR(100),
  error_message      TEXT,
  error_raw          JSONB,
  duration_ms        INTEGER,

  -- Timestamps
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at — this table is immutable. INSERT only.
);

CREATE INDEX idx_event_log_organization_id    ON event_log(organization_id);
CREATE INDEX idx_event_log_lead_timeline      ON event_log(organization_id, lead_id, occurred_at ASC);
CREATE INDEX idx_event_log_play_instance      ON event_log(organization_id, play_instance_id, occurred_at ASC);
CREATE INDEX idx_event_log_workflow_run       ON event_log(workflow_run_id) WHERE workflow_run_id IS NOT NULL;
CREATE INDEX idx_event_log_event_type         ON event_log(organization_id, event_type, occurred_at DESC);
CREATE INDEX idx_event_log_idempotency_key    ON event_log(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_event_log_idempotency_key;
-- DROP INDEX IF EXISTS idx_event_log_event_type;
-- DROP INDEX IF EXISTS idx_event_log_workflow_run;
-- DROP INDEX IF EXISTS idx_event_log_play_instance;
-- DROP INDEX IF EXISTS idx_event_log_lead_timeline;
-- DROP INDEX IF EXISTS idx_event_log_organization_id;
-- DROP TABLE IF EXISTS event_log;
-- DROP TYPE IF EXISTS event_status;
-- DROP TYPE IF EXISTS actor_type;
-- DROP TYPE IF EXISTS event_type;
