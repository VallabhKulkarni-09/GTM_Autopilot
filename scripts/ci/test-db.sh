#!/usr/bin/env bash
# Starts a throwaway local Supabase (Postgres + REST only), applies every migration and seeds one
# workspace, then prints the env vars the DB-backed tests need. Used by CI and by contributors:
#
#   eval "$(scripts/ci/test-db.sh)"     # start + export env
#   CI=true npm run test:run           # CI=true: DB-backed suites must run, never skip
#   scripts/ci/test-db.sh stop          # tear down
#
# Never point these tests at a real project: they create and delete rows.
# The keys below are the public defaults every local `supabase start` uses; they are not secrets.
set -euo pipefail

SUPABASE_CLI="npx -y supabase@2.98.0"
WORKDIR="${TEST_DB_WORKDIR:-${TMPDIR:-/tmp}/gtm-autopilot-test-db}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
API_URL="http://127.0.0.1:54321"
LOCAL_JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"
TEST_ORG_ID="00000000-0000-4000-8000-0000000000c1"

if [[ "${1:-}" == "stop" ]]; then
  (cd "$WORKDIR" && $SUPABASE_CLI stop --no-backup) >&2
  exit 0
fi

mkdir -p "$WORKDIR"
cd "$WORKDIR"
[[ -f supabase/config.toml ]] || $SUPABASE_CLI init --force >&2
# Only Postgres, PostgREST and the gateway: the API talks to Supabase through supabase-js (REST).
# Image pulls can hit registry rate limits; retry a few times before giving up (exit non-zero).
for attempt in 1 2 3; do
  if $SUPABASE_CLI start -x gotrue,realtime,storage-api,imgproxy,edge-runtime,logflare,vector,studio,postgres-meta,mailpit,supavisor >&2; then
    break
  fi
  if [[ $attempt == 3 ]]; then echo "test-db: could not start local Supabase after 3 attempts" >&2; exit 1; fi
  echo "test-db: start failed (attempt $attempt), retrying in $((attempt * 20))s" >&2
  sleep $((attempt * 20))
done

cd "$REPO_ROOT"
# A fresh database every run: reset the public schema, then apply all migrations.
node -e "
  const pg = require('pg'); const c = new pg.Client({ connectionString: process.argv[1] });
  c.connect()
    .then(() => c.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS langgraph CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres, anon, authenticated, service_role; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;'))
    .then(() => c.end())
    .catch(e => { console.error(e.message); process.exit(1) })
" "$DB_URL" >&2
SUPABASE_DB_URL="$DB_URL" DOTENV_CONFIG_QUIET=true node db/migrate.js >&2
node -e "
  const pg = require('pg'); const c = new pg.Client({ connectionString: process.argv[1] });
  c.connect()
    .then(() => c.query(\"INSERT INTO organizations (id, name, slug, is_active) VALUES (\$1, 'CI workspace', 'ci-workspace', true) ON CONFLICT (id) DO NOTHING\", [process.argv[2]]))
    .then(() => c.query(\"NOTIFY pgrst, 'reload schema'\"))
    .then(() => c.end())
    .catch(e => { console.error(e.message); process.exit(1) })
" "$DB_URL" "$TEST_ORG_ID" >&2

SERVICE_KEY="$(node --input-type=module -e "
  import { SignJWT } from 'jose'
  console.log(await new SignJWT({ role: 'service_role' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('supabase-demo').setIssuedAt().setExpirationTime('6h')
    .sign(new TextEncoder().encode('$LOCAL_JWT_SECRET')))
")"

cat <<EOF
export SUPABASE_URL=$API_URL
export SUPABASE_SERVICE_KEY=$SERVICE_KEY
export DEFAULT_ORG_ID=$TEST_ORG_ID
export CHECKPOINT_TEST_DB_URL=$DB_URL
EOF
