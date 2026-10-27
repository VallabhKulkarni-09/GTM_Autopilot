#!/usr/bin/env node
/**
 * migrate.js — applies db/migrations/*.sql once each, tracked in schema_migrations.
 *
 * Usage:
 *   npm run migrate
 *   npm run migrate -- --baseline 024   # existing DB created before the ledger: mark 001–024 as applied
 *
 * Requires SUPABASE_DB_URL (Supabase → Project Settings → Database → Connection string → URI).
 */

import pg from 'pg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'
import { runMigrations, sslFor } from './migrate-lib.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(__dirname, '..', '.env') })

const DB_URL = process.env.SUPABASE_DB_URL
if (!DB_URL) {
  console.error('\n❌ SUPABASE_DB_URL is not set.')
  console.error('   Supabase → Project Settings → Database → Connection string → URI')
  console.error('   Format: postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres\n')
  process.exit(1)
}

const baselineIdx = process.argv.indexOf('--baseline')
const baseline = baselineIdx > -1 ? process.argv[baselineIdx + 1] : undefined
if (baselineIdx > -1 && !/^\d{3}$/.test(baseline ?? '')) {
  console.error('❌ --baseline needs a 3-digit migration number, e.g. --baseline 024')
  process.exit(1)
}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')
const files = fs.readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(filename => ({ filename, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8') }))

async function verify(client) {
  const checks = []
  const q = (text, params) => client.query(text, params).then(r => r.rows)

  checks.push({
    name: 'event_log has no updated_at column',
    passed: (await q(`SELECT 1 FROM information_schema.columns WHERE table_name='event_log' AND column_name='updated_at'`)).length === 0,
  })
  checks.push({
    name: 'event_log.decision_snapshot is NOT NULL',
    passed: (await q(`SELECT is_nullable FROM information_schema.columns WHERE table_name='event_log' AND column_name='decision_snapshot'`))[0]?.is_nullable === 'NO',
  })
  for (const table of ['leads', 'companies', 'external_identity', 'evidence', 'policy_rules', 'action_risk_registry',
    'play_instance', 'event_log', 'action_execution_state', 'connector_config', 'routing_state']) {
    checks.push({
      name: `${table}.organization_id present`,
      passed: (await q(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='organization_id'`, [table])).length > 0,
    })
  }
  return checks
}

async function main() {
  const client = new pg.Client({ connectionString: DB_URL, ssl: sslFor(DB_URL), connectionTimeoutMillis: 10000 })
  try {
    await client.connect()
    const result = await runMigrations(client, files, { baseline, log: console.log })
    console.log(`\nApplied ${result.applied.length}, already applied ${result.skipped.length}, baselined ${result.baselined.length}.`)

    const checks = await verify(client)
    for (const c of checks) console.log(`  ${c.passed ? '✓' : '✗'} ${c.name}`)
    if (checks.some(c => !c.passed)) {
      console.error('\n❌ Schema checks failed.')
      process.exitCode = 1
    } else {
      console.log('\n✅ Database is up to date.')
    }
  } catch (err) {
    console.error(`\n❌ ${err.code ?? 'ERROR'}: ${err.message}\n`)
    process.exitCode = 1
  } finally {
    await client.end().catch(() => {})
  }
}

main()
