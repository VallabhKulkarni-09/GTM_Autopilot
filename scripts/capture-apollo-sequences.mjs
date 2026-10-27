#!/usr/bin/env node
/**
 * capture-apollo-sequences.mjs
 *
 * Captures real Apollo Sequences API responses as test fixtures, so the
 * connector types are written from reality rather than from docs.
 *
 * Default (read-only, safe):
 *   GET  /email_accounts
 *   POST /emailer_campaigns/search
 *   POST /contacts/search            (q_keywords = APOLLO_TEST_EMAIL)
 *
 * With --write (creates a real contact and adds it to a real sequence;
 * the sequence may send real email to APOLLO_TEST_EMAIL):
 *   POST /contacts                   (run_dedupe = true)
 *   POST /emailer_campaigns/{id}/add_contact_ids
 *   Requires APOLLO_TEST_EMAIL, APOLLO_TEST_SEQUENCE_ID, APOLLO_TEST_EMAIL_ACCOUNT_ID.
 *
 * Usage:
 *   node -r dotenv/config scripts/capture-apollo-sequences.mjs
 *   APOLLO_TEST_EMAIL=you@yourco.com APOLLO_TEST_SEQUENCE_ID=... APOLLO_TEST_EMAIL_ACCOUNT_ID=... \
 *     node -r dotenv/config scripts/capture-apollo-sequences.mjs --write
 *
 * Fixtures are written to src/connectors/apollo/__tests__/fixtures/ with email
 * addresses replaced by placeholders. Do NOT run in CI.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'https://api.apollo.io/api/v1'
const KEY = process.env.APOLLO_API_KEY
const WRITE = process.argv.includes('--write')
const TEST_EMAIL = process.env.APOLLO_TEST_EMAIL
const SEQ_ID = process.env.APOLLO_TEST_SEQUENCE_ID
const ACCOUNT_ID = process.env.APOLLO_TEST_EMAIL_ACCOUNT_ID
const OUT = join(process.cwd(), 'src/connectors/apollo/__tests__/fixtures')

if (!KEY) { console.error('Set APOLLO_API_KEY in .env'); process.exit(1) }

const headers = { 'x-api-key': KEY, 'Content-Type': 'application/json', Accept: 'application/json' }

/** Replace email addresses so fixtures do not carry real mailbox names. */
function redact(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) =>
    typeof v === 'string' ? v.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'user@example.com') : v))
}

async function call(label, method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  console.log(`\n── ${label}: ${method} ${path.split('?')[0]} → HTTP ${res.status}`)
  console.log(typeof parsed === 'string' ? parsed.slice(0, 500) : JSON.stringify(redact(parsed), null, 2).slice(0, 1500))
  const file = `apollo-${label}.fixture.json`
  writeFileSync(join(OUT, file), JSON.stringify({ status: res.status, body: redact(parsed) }, null, 2) + '\n')
  console.log(`   saved ${file}`)
  return { status: res.status, body: parsed }
}

await call('email-accounts', 'GET', '/email_accounts')
await call('sequences-search', 'POST', '/emailer_campaigns/search', { page: 1, per_page: 25 })
if (TEST_EMAIL) await call('contacts-search', 'POST', '/contacts/search', { q_keywords: TEST_EMAIL, page: 1, per_page: 5 })

if (WRITE) {
  if (!TEST_EMAIL || !SEQ_ID || !ACCOUNT_ID) {
    console.error('--write needs APOLLO_TEST_EMAIL, APOLLO_TEST_SEQUENCE_ID, APOLLO_TEST_EMAIL_ACCOUNT_ID')
    process.exit(1)
  }
  const created = await call('contact-create', 'POST', '/contacts', {
    email: TEST_EMAIL, first_name: 'Autopilot', last_name: 'Test', run_dedupe: true,
  })
  const contactId = created.body?.contact?.id
  if (!contactId) { console.error('No contact id returned; stopping.'); process.exit(1) }
  const qs = new URLSearchParams({ emailer_campaign_id: SEQ_ID, send_email_from_email_account_id: ACCOUNT_ID })
  qs.append('contact_ids[]', contactId)
  await call('sequence-add-contacts', 'POST', `/emailer_campaigns/${SEQ_ID}/add_contact_ids?${qs}`)
  console.log(`\nContact ${contactId} → sequence ${SEQ_ID}. Record these IDs in docs/history.`)
}
