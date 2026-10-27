/**
 * setup.ts — BullMQ queue definitions and Redis connection.
 * Exports queue instances, addJob helper, and job registration helpers.
 */

import { Redis } from 'ioredis'
import { Queue } from 'bullmq'

// ─── Redis connection ─────────────────────────────────────────────────────────
// IMPORTANT: { url: '...' } is NOT valid ioredis options — the url key is
// silently ignored and ioredis falls back to localhost:6379.
// new Redis(url) is the correct pattern for URL-based connections.
export const redisConnection = new Redis(
  process.env.REDIS_URL ?? 'redis://localhost:6379',
  { maxRetriesPerRequest: null }   // required by BullMQ
)

// ─── Queue definitions ────────────────────────────────────────────────────────

export const inboundLeadQueue        = new Queue('inbound-lead-processing',  { connection: redisConnection })
export const advancePlayQueue        = new Queue('advance-play-step',        { connection: redisConnection })
export const escalateQueue           = new Queue('escalate-play',            { connection: redisConnection })
export const slaTimerQueue           = new Queue('sla-timer',                { connection: redisConnection })
export const outcomePollerQueue      = new Queue('outcome-detection-poller', { connection: redisConnection })
export const outcomeWindowCloserQueue = new Queue('outcome-window-closer',    { connection: redisConnection })
export const resumePlayQueue         = new Queue('resume-play',              { connection: redisConnection })
export const evaluateModelQueue      = new Queue('evaluate-model',           { connection: redisConnection })

// ─── addJob helper ────────────────────────────────────────────────────────────

export async function addJob(
  queueName:
    | 'inbound-lead-processing'
    | 'advance-play-step'
    | 'escalate-play'
    | 'sla-timer'
    | 'outcome-detection-poller'
    | 'outcome-window-closer'
    | 'resume-play'
    | 'evaluate-model',
  data: Record<string, unknown>,
  /** jobId: BullMQ ignores a second add with the same id while the first is kept — used for idempotent enqueues. */
  options?: { priority?: number; jobId?: string; attempts?: number }
): Promise<void> {
  const queues: Record<string, Queue> = {
    'inbound-lead-processing':  inboundLeadQueue,
    'advance-play-step':        advancePlayQueue,
    'escalate-play':            escalateQueue,
    'sla-timer':                slaTimerQueue,
    'outcome-detection-poller': outcomePollerQueue,
    'outcome-window-closer':    outcomeWindowCloserQueue,
    'resume-play':              resumePlayQueue,
    'evaluate-model':           evaluateModelQueue,
  }

  const queue = queues[queueName]
  if (!queue) throw new Error(`Unknown queue: ${queueName}`)

  await queue.add(queueName, data, {
    removeOnComplete: 1000,
    removeOnFail:     500,
    priority:         options?.priority,
    ...(options?.jobId ? { jobId: options.jobId } : {}),
    attempts:         options?.attempts ?? 3,
    backoff: {
      type:  'exponential',
      delay: 1_000,   // 1s → 2s → 4s between retries
    },
  })
}

// ─── SLA timer repeatable job ─────────────────────────────────────────────────
// Runs every 2 minutes. Called once at startup.

export async function registerSlaTimer(): Promise<void> {
  // BullMQ v5+: use upsertJobScheduler for repeatable jobs
  await slaTimerQueue.upsertJobScheduler(
    'sla-check',
    { every: 2 * 60 * 1000 },
    {
      name: 'sla-check',
      data: { trigger: 'scheduled' },
      opts: {
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    }
  )
}

// ─── Outcome detection poller repeatable job ──────────────────────────────────
// Interval via OUTCOME_POLL_INTERVAL_MS env var, default 10 minutes.

export async function registerOutcomePoller(): Promise<void> {
  const intervalMs = parseInt(process.env.OUTCOME_POLL_INTERVAL_MS ?? '', 10) || 10 * 60 * 1000
  await outcomePollerQueue.upsertJobScheduler(
    'outcome-poll',
    { every: intervalMs },
    {
      name: 'outcome-poll',
      data: { trigger: 'scheduled' },
      opts: {
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    }
  )
}

// ─── Outcome window closer repeatable job ─────────────────────────────────────
// Interval via OUTCOME_WINDOW_CLOSE_INTERVAL_MS env var, default 1 hour.

export async function registerOutcomeWindowCloser(): Promise<void> {
  const intervalMs = parseInt(process.env.OUTCOME_WINDOW_CLOSE_INTERVAL_MS ?? '', 10) || 60 * 60 * 1000
  await outcomeWindowCloserQueue.upsertJobScheduler(
    'outcome-window-close',
    { every: intervalMs },
    {
      name: 'outcome-window-close',
      data: { trigger: 'scheduled' },
      opts: {
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    }
  )
}
