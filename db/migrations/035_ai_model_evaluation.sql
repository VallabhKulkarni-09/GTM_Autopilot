-- Migration: 035_ai_model_evaluation.sql
-- Description: Golden-set runs per (provider, model) and the qualification agent switch (v2 step 4).
--   ai_model_evaluation  one row per "Run test leads". status running → completed | failed.
--                        Identity of what was tested: provider, model, model_digest, prompt_version, agent_version,
--                        dataset_version. The agent can only be switched on for a completed run that matches the
--                        workspace's current model + prompt + agent version.
--   ai_model_config.qualification_agent_enabled  off by default; turned off again whenever the model changes.
-- Rollback: see bottom of file

-- FORWARD MIGRATION
CREATE TABLE IF NOT EXISTS ai_model_evaluation (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL REFERENCES organizations(id),
  agent                  TEXT NOT NULL CHECK (agent IN ('qualification')),
  provider               TEXT NOT NULL,
  model                  TEXT NOT NULL,
  model_digest           TEXT,
  prompt_version         TEXT NOT NULL,
  agent_version          TEXT NOT NULL,
  dataset_version        TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  requested_by           UUID NOT NULL,
  summary                JSONB,          -- { agreed, total, injection:{agreed,total}, reviews, fallbacks, baseline:{agreed,total} }
  results                JSONB,          -- per-case rows (no lead data beyond the fictional golden cases)
  error                  TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_model_evaluation_organization_id_started_at
  ON ai_model_evaluation (organization_id, started_at DESC);
-- At most one run in progress per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_evaluation_organization_id_running
  ON ai_model_evaluation (organization_id) WHERE status = 'running';

ALTER TABLE ai_model_evaluation ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_model_config
  ADD COLUMN IF NOT EXISTS qualification_agent_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS qualification_evaluation_id UUID REFERENCES ai_model_evaluation(id);

-- ROLLBACK
-- ALTER TABLE ai_model_config DROP COLUMN IF EXISTS qualification_evaluation_id, DROP COLUMN IF EXISTS qualification_agent_enabled;
-- DROP INDEX IF EXISTS idx_ai_model_evaluation_organization_id_running;
-- DROP INDEX IF EXISTS idx_ai_model_evaluation_organization_id_started_at;
-- DROP TABLE IF EXISTS ai_model_evaluation;
