/**
 * escalate.worker.ts — runs processEscalation for 'escalate-play' jobs.
 * v1: in-app only (escalation_sent, channel 'in_app'); Slack is out of scope.
 */

import { Worker } from 'bullmq'
import { redisConnection } from '../setup.js'
import { processEscalation, type EscalatePlayJob } from '../jobs/escalate-play.js'

export const escalateWorker = new Worker(
  'escalate-play',
  async job => processEscalation(job.data as EscalatePlayJob),
  { connection: redisConnection, concurrency: 10 },
)

escalateWorker.on('failed', (job, err) => {
  console.error(`[escalate-worker] Job ${job?.id} for play ${(job?.data as EscalatePlayJob | undefined)?.playId} failed: ${err.message}`)
})
