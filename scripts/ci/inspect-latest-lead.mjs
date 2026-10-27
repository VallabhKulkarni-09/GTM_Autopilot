#!/usr/bin/env node
/**
 * Live-check helper: prints the newest lead in a workspace with its play, timeline and
 * external IDs. No secrets, emails masked.
 *   node scripts/ci/inspect-latest-lead.mjs <workspace-id>
 */
import 'dotenv/config'
import pg from 'pg'

const org = process.argv[2]
if (!org) { console.error('usage: node scripts/ci/inspect-latest-lead.mjs <workspace-id>'); process.exit(1) }
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, statement_timeout: 20000 })
await c.connect()
const q = (s, p) => c.query(s, p).then(r => r.rows)

const [l] = await q('select id,email,title,stage,icp_score,icp_tier,company_id,created_at from leads where organization_id=$1 order by created_at desc limit 1', [org])
if (!l) { console.log('no leads'); process.exit(0) }
console.log('LEAD', l.id, l.email.replace(/^(.{2}).*@/, '$1***@'), '|', l.title, '| stage', l.stage, '| score', l.icp_score, l.icp_tier, '| company linked', Boolean(l.company_id), '| created', l.created_at.toISOString())
const [p] = await q('select id,status,assigned_owner_name,review_kind from play_instance where lead_id=$1', [l.id])
console.log('PLAY', JSON.stringify(p))
for (const e of await q("select occurred_at,event_type,event_status,proposed_action->>'type' pa,error_message from event_log where lead_id=$1 order by occurred_at", [l.id])) {
  console.log(e.occurred_at.toISOString().slice(11, 19), e.event_type.padEnd(28), (e.event_status ?? '').padEnd(8), (e.pa ?? '').padEnd(15), (e.error_message ?? '').slice(0, 110))
}
console.log('IDS', JSON.stringify(await q('select provider,entity_type,external_id from external_identity where entity_id=$1', [l.id])))
const [out] = await q("select actions from policy_rules where organization_id=$1 and rule_type='outreach' and is_active", [org])
console.log('OUTREACH POLICY', JSON.stringify(out?.actions))
const reps = await q("select metadata->>'name' n, metadata->>'available' a, metadata->>'sf_active' s from external_identity where organization_id=$1 and provider='salesforce' and entity_type='user'", [org])
console.log('REPS', reps.map(r => r.n + (r.s === 'true' && r.a === 'true' ? '' : ' [off]')).join(', '))
await c.end()
