-- Migration: 037_ai_routing_agent.sql
-- Description: RoutingAgent v2 switch (v2 step 5). One golden-set run tests both agents; the run
--   records the routing prompt/agent version it used so the routing switch can be gated on it.
--   ai_model_config.routing_agent_enabled  off by default; reset whenever the model changes.
-- Rollback: see bottom of file

-- FORWARD MIGRATION
ALTER TABLE ai_model_evaluation
  ADD COLUMN IF NOT EXISTS routing_prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS routing_agent_version  TEXT,
  ADD COLUMN IF NOT EXISTS routing_results        JSONB;

ALTER TABLE ai_model_config
  ADD COLUMN IF NOT EXISTS routing_agent_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS routing_evaluation_id  UUID REFERENCES ai_model_evaluation(id);

-- ROLLBACK
-- ALTER TABLE ai_model_config DROP COLUMN IF EXISTS routing_evaluation_id, DROP COLUMN IF EXISTS routing_agent_enabled;
-- ALTER TABLE ai_model_evaluation DROP COLUMN IF EXISTS routing_results, DROP COLUMN IF EXISTS routing_agent_version, DROP COLUMN IF EXISTS routing_prompt_version;
