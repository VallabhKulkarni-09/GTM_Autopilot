-- Migration: 015_play_instance_pending_approval.sql
-- Description: Adds pending_approval_since to play_instance.
--              Required by request_human_review action in action-executor.ts.
--              Set when a play is paused waiting for a human routing decision.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

ALTER TABLE play_instance
  ADD COLUMN IF NOT EXISTS pending_approval_since TIMESTAMPTZ;

COMMENT ON COLUMN play_instance.pending_approval_since IS
  'Timestamp when the play was paused for human routing approval. NULL if not in human-review state.';

-- ROLLBACK
-- ALTER TABLE play_instance DROP COLUMN IF EXISTS pending_approval_since;
