/**
 * start-workers.ts
 * Entry point that starts all BullMQ workers.
 * Import this once at server startup (in server.ts) or run standalone.
 *
 * Org resolution for SLA/outcome workers:
 *   1. If ACTIVE_ORG_IDS is set (comma-separated UUIDs), use it directly.
 *      This is useful for Railway deployments where you want an explicit override.
 *   2. Otherwise, query organizations WHERE is_active = TRUE from the DB.
 *      This is the safe default — it works for multi-org without env var maintenance.
 *   3. If neither produces org IDs, the job workers log a CRITICAL error and skip.
 *      runSlaTimer / runOutcomeDetectionPoller both fail loudly on empty input.
 */

import './workers/inbound-lead.worker.js'
import './workers/escalate.worker.js'
import './workers/resume-play.worker.js'
import './workers/evaluate-model.worker.js'
import { getCheckpointer } from '../workflows/checkpointer.js'
import {
  registerSlaTimer,
  registerOutcomePoller,
  registerOutcomeWindowCloser,
  redisConnection,
  outcomePollerQueue,
  outcomeWindowCloserQueue,
} from './setup.js'
import { runSlaTimer } from './jobs/sla-timer.js'
import { runOutcomeDetectionPoller } from './jobs/outcome-detection-poller.js'
import { runOutcomeWindowCloser } from './jobs/outcome-window-closer.js'
import { getDb } from '../db/client.js'
import { Worker } from 'bullmq'

/**
 * Resolve the list of active organization IDs.
 * ACTIVE_ORG_IDS env var takes precedence (allows Railway override without a DB round-trip).
 * Falls back to querying organizations.is_active = true.
 */
async function resolveActiveOrgIds(): Promise<string[]> {
  const envOverride = (process.env.ACTIVE_ORG_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (envOverride.length > 0) {
    console.log(`[workers] Using ACTIVE_ORG_IDS override: ${envOverride.length} org(s)`)
    return envOverride
  }

  // Query DB for all active orgs. This is the default path.
  try {
    const { data, error } = await getDb()
      .from('organizations')
      .select('id')
      .eq('is_active', true)

    if (error) {
      console.error(`[workers] Failed to query active orgs from DB: ${error.message}`)
      return []
    }
    const ids = (data ?? []).map((r: any) => r.id as string)
    if (ids.length === 0) {
      console.error('[workers] CRITICAL: No active organizations found in DB — SLA and outcome jobs will not run.')
    } else {
      console.log(`[workers] Resolved ${ids.length} active org(s) from DB`)
    }
    return ids
  } catch (err) {
    console.error(`[workers] Unexpected error resolving active orgs: ${err}`)
    return []
  }
}

// ── SLA timer worker ──────────────────────────────────────────────────────────
const slaWorker = new Worker(
  'sla-timer',
  async (_job) => {
    const orgIds = await resolveActiveOrgIds()
    await runSlaTimer(orgIds)
  },
  { connection: redisConnection, concurrency: 1 }
)

// ── Outcome detection poller worker ──────────────────────────────────────────
const outcomePollerWorker = new Worker(
  'outcome-detection-poller',
  async (_job) => {
    const orgIds = await resolveActiveOrgIds()
    await runOutcomeDetectionPoller(orgIds)
  },
  { connection: redisConnection, concurrency: 1 }
)

// ── Outcome window closer worker ──────────────────────────────────────────────
const outcomeWindowCloserWorker = new Worker(
  'outcome-window-closer',
  async (_job) => {
    const orgIds = await resolveActiveOrgIds()
    await runOutcomeWindowCloser(orgIds)
  },
  { connection: redisConnection, concurrency: 1 }
)

// ── Register all repeatable jobs ──────────────────────────────────────────────
registerSlaTimer().then(() => {
  console.log('[workers] SLA timer registered')
}).catch(console.error)

registerOutcomePoller().then(() => {
  console.log('[workers] Outcome detection poller registered')
}).catch(console.error)

registerOutcomeWindowCloser().then(() => {
  console.log('[workers] Outcome window closer registered')
}).catch(console.error)

// Plays can pause for human review; without durable checkpoints a pause would be lost,
// so a worker that cannot reach the checkpoint store must not run at all.
try {
  getCheckpointer()
    .then(() => console.log('[workers] Durable checkpoints ready (Postgres schema "langgraph")'))
    .catch(err => { console.error(`[workers] CRITICAL: checkpoint store unavailable: ${err?.message ?? err}`); process.exit(1) })
} catch (err: any) {
  console.error(`[workers] CRITICAL: ${err?.message ?? err}`)
  process.exit(1)
}

console.log('[workers] All BullMQ workers started')

export { slaWorker, outcomePollerWorker, outcomeWindowCloserWorker }
