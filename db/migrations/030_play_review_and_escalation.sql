-- Migration: 030_play_review_and_escalation.sql
-- Description: Durable human review + in-app escalation (v1 Task 10).
--   play_instance gets the state the Approvals page and "Needs attention" card read:
--     review_kind        'routing' (no rep could be picked) | 'sequence' (outreach needs sign-off)
--     review_context     what the reviewer needs: reason codes, queue, suggested owner
--     review_decision    the human's decision (approved/rejected, chosen owner, note, who)
--     review_decided_at  set atomically on the first decision; makes approve/reject idempotent
--     review_decided_by  auth user id of the reviewer
--     escalated_at / escalation_reason  last in-app escalation (escalate worker)
--   LangGraph checkpoints live in schema "langgraph", created by PostgresSaver.setup()
--   at worker start (library-managed tables keyed by thread_id = workflow_run_id).
-- Rollback: see bottom of file

-- FORWARD MIGRATION
ALTER TABLE play_instance
  ADD COLUMN IF NOT EXISTS review_kind        VARCHAR(20),
  ADD COLUMN IF NOT EXISTS review_context     JSONB,
  ADD COLUMN IF NOT EXISTS review_decision    JSONB,
  ADD COLUMN IF NOT EXISTS review_decided_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_decided_by  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS escalated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalation_reason  VARCHAR(100);

-- Approvals list: paused plays per org, oldest first
CREATE INDEX IF NOT EXISTS idx_play_instance_organization_id_pending_approval
  ON play_instance (organization_id, pending_approval_since)
  WHERE status = 'paused';

-- Needs attention: breached / escalated plays not yet contacted
CREATE INDEX IF NOT EXISTS idx_play_instance_organization_id_attention
  ON play_instance (organization_id, sla_breached_at, escalated_at)
  WHERE first_touch_at IS NULL;

-- Existing paused plays came from routing reviews (the only path that paused before this).
UPDATE play_instance SET review_kind = 'routing'
WHERE status = 'paused' AND review_kind IS NULL;

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_play_instance_organization_id_attention;
-- DROP INDEX IF EXISTS idx_play_instance_organization_id_pending_approval;
-- ALTER TABLE play_instance
--   DROP COLUMN IF EXISTS escalation_reason, DROP COLUMN IF EXISTS escalated_at,
--   DROP COLUMN IF EXISTS review_decided_by, DROP COLUMN IF EXISTS review_decided_at,
--   DROP COLUMN IF EXISTS review_decision, DROP COLUMN IF EXISTS review_context,
--   DROP COLUMN IF EXISTS review_kind;
-- DROP SCHEMA IF EXISTS langgraph CASCADE;  -- only if abandoning durable review entirely
