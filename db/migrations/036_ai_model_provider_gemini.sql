-- Migration: 036_ai_model_provider_gemini.sql
-- Description: Allow 'gemini' (Google AI Studio / Gemini API) as an AI model provider.
--   Cloud provider: fixed base URL in code, API key required, consent required (existing
--   ai_model_config_cloud_has_consent constraint already covers every non-local provider).
-- Rollback: see bottom of file

-- FORWARD MIGRATION
ALTER TABLE ai_model_config DROP CONSTRAINT IF EXISTS ai_model_config_provider_check;
ALTER TABLE ai_model_config ADD CONSTRAINT ai_model_config_provider_check
  CHECK (provider IN ('ollama', 'openai_compatible', 'openai', 'openrouter', 'anthropic', 'gemini'));

-- ROLLBACK
-- ALTER TABLE ai_model_config DROP CONSTRAINT IF EXISTS ai_model_config_provider_check;
-- ALTER TABLE ai_model_config ADD CONSTRAINT ai_model_config_provider_check
--   CHECK (provider IN ('ollama', 'openai_compatible', 'openai', 'openrouter', 'anthropic'));
