/**
 * resume-play.worker.ts — runs processResumePlay for 'resume-play' jobs.
 * After the last failed attempt the play is marked failed with the reason, so it does
 * not sit in 'running' silently (the failure events are already in event_log).
 */

import { Worker } from 'bullmq'
import { redisConnection } from '../setup.js'
import { getDb } from '../../db/client.js'
import { processResumePlay, type ResumePlayJob } from '../jobs/resume-play.js'
import { resumeInboundLeadPlay } from '../../workflows/inbound-lead/graph.js'

export const resumePlayWorker = new Worker(
  'resume-play',
  async job => {
    const result = await processResumePlay(job.data as ResumePlayJob, { resume: resumeInboundLeadPlay })
    console.log(`[resume-play] Play ${(job.data as ResumePlayJob).playId}: ${JSON.stringify(result)}`)
    return result
  },
  { connection: redisConnection, concurrency: 5 },
)

resumePlayWorker.on('failed', async (job, err) => {
  if (!job) return
  console.error(`[resume-play] Job ${job.id} failed (attempt ${job.attemptsMade}): ${err.message}`)
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return
  const { playId, organizationId } = job.data as ResumePlayJob
  const { error } = await getDb()
    .from('play_instance')
    .update({ status: 'failed', failure_reason: `RESUME_FAILED: ${err.message}`.slice(0, 500), updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('id', playId)
    .eq('status', 'running')
  if (error) console.error(`[resume-play] Could not mark play ${playId} failed: ${error.message}`)
})
