/**
 * server.ts — Starts the Fastify server (API only).
 *
 * Worker processes are started by start-workers.ts in a SEPARATE container
 * (Dockerfile.worker). They must NOT run inside the API container.
 *
 * To run workers in the same process (local dev only), set:
 *   RUN_WORKERS_IN_PROCESS=true
 *
 * In production (Railway): keep this unset. The worker container handles it.
 */

import 'dotenv/config'
import { buildApp } from './app.js'

// ─── Worker co-location guard ─────────────────────────────────────────────────
// Only start workers in this process when explicitly opted in.
// This prevents double execution when both the API container and the dedicated
// worker container import start-workers (duplicate SLA timers, lock contention).
if (process.env.RUN_WORKERS_IN_PROCESS === 'true') {
  console.log('[server] RUN_WORKERS_IN_PROCESS=true — starting workers in API process (dev mode)')
  await import('./queue/start-workers.js')
}

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'

const app = buildApp()

app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
  app.log.info(`GTM Autopilot API running at ${address}`)
})

async function gracefulShutdown(signal: string): Promise<void> {
  app.log.info(`[server] ${signal} received — starting graceful shutdown`)
  try {
    await app.close()
    app.log.info('[server] Fastify closed cleanly')
    process.exit(0)
  } catch (err) {
    app.log.error({ err }, '[server] Error during shutdown')
    process.exit(1)
  }
}

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
process.on('SIGINT',  () => { void gracefulShutdown('SIGINT') })
