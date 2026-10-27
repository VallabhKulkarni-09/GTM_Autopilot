-- Migration: 022_oauth_nonce.sql
-- Description: Server-side nonce store for OAuth2 flows (Outreach, Salesloft).
--              Replaces the unauthenticated ?org_id= query-param pattern.
--              A nonce is created by an authenticated POST /api/:connector/oauth/start,
--              stored here with the org_id and a 10-minute expiry, then consumed once
--              by the OAuth callback. Consuming = DELETE (single use).
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TABLE IF NOT EXISTS oauth_nonce (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nonce           TEXT        NOT NULL UNIQUE,
  connector_name  TEXT        NOT NULL,   -- 'outreach' | 'salesloft'
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for O(1) nonce lookup in callback
CREATE INDEX IF NOT EXISTS oauth_nonce_nonce_idx     ON oauth_nonce(nonce);
-- Index for periodic cleanup of expired rows
CREATE INDEX IF NOT EXISTS oauth_nonce_expires_idx   ON oauth_nonce(expires_at);
-- Index for org-scoped queries (e.g. "show pending OAuth for this org")
CREATE INDEX IF NOT EXISTS oauth_nonce_org_idx       ON oauth_nonce(organization_id);

COMMENT ON TABLE oauth_nonce IS
  'Single-use server-side nonces for OAuth2 authorization flows. '
  'Each nonce ties an org_id to an OAuth state parameter. '
  'Nonces expire after 10 minutes and are deleted on first use.';

-- RLS: only the service role can read/write (callback is unauthenticated browser redirect).
-- RLS is enabled but no permissive policies for authenticated roles — all access via service key.
ALTER TABLE oauth_nonce ENABLE ROW LEVEL SECURITY;

-- ROLLBACK
-- DROP INDEX IF EXISTS oauth_nonce_org_idx;
-- DROP INDEX IF EXISTS oauth_nonce_expires_idx;
-- DROP INDEX IF EXISTS oauth_nonce_nonce_idx;
-- DROP TABLE IF EXISTS oauth_nonce;
