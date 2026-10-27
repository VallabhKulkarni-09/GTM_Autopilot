#!/usr/bin/env node
/**
 * One-time migration for existing installs: copy HubSpot / Salesforce / Apollo credentials
 * from .env into a workspace's encrypted connector settings. After this, remove them from .env.
 *
 *   npm run build && node scripts/import-env-credentials.mjs <workspace-id>
 *
 * Every connection is tested live before it is stored; a failing one is reported and skipped.
 */
import 'dotenv/config'
import { testCredentials } from '../dist/routes/api/connectors.js'
import { saveConnectorCredentials, recordHealth } from '../dist/repositories/connector-credentials.repository.js'

const orgId = process.argv[2]
if (!/^[0-9a-f-]{36}$/i.test(orgId ?? '')) {
  console.error('Usage: node scripts/import-env-credentials.mjs <workspace-id (uuid)>')
  process.exit(1)
}
const env = process.env
const candidates = {
  hubspot: env.HUBSPOT_API_KEY && env.HUBSPOT_WEBHOOK_SECRET
    ? { public: { portal_id: '' }, secrets: { apiKey: env.HUBSPOT_API_KEY, webhookSecret: env.HUBSPOT_WEBHOOK_SECRET } } : null,
  salesforce: env.SF_INSTANCE_URL && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET
    ? { public: { instanceUrl: env.SF_INSTANCE_URL.replace(/\/$/, ''), sandbox: env.SF_SANDBOX === 'true' }, secrets: { clientId: env.SF_CLIENT_ID, clientSecret: env.SF_CLIENT_SECRET } } : null,
  apollo: env.APOLLO_API_KEY ? { public: {}, secrets: { apiKey: env.APOLLO_API_KEY } } : null,
}

let failed = false
for (const [name, creds] of Object.entries(candidates)) {
  if (!creds) { console.log(`- ${name}: not in .env, skipped`); continue }
  const outcome = await testCredentials(name, creds)
  if (!outcome.ok) { console.log(`✗ ${name}: ${outcome.error} — ${outcome.message}`); failed = true; continue }
  await saveConnectorCredentials(orgId, name, outcome.credentials)
  await recordHealth(orgId, name, true)
  console.log(`✓ ${name}: tested and stored${outcome.details?.portal_id ? ` (HubSpot portal ${outcome.details.portal_id})` : ''}`)
}
process.exit(failed ? 1 : 0)
