/**
 * evaluate-model.worker.ts — one golden-set run at a time per worker process (model calls are
 * also limited process-wide by the model client's semaphore).
 */
import { Worker } from 'bullmq'
import { redisConnection } from '../setup.js'
import { processEvaluateModel, type EvaluateModelJob } from '../jobs/evaluate-model.js'

export const evaluateModelWorker = new Worker(
  'evaluate-model',
  async job => {
    const result = await processEvaluateModel(job.data as EvaluateModelJob)
    console.log(`[evaluate-model] Run ${(job.data as EvaluateModelJob).evaluationId}: ${result.status}`)
    return result
  },
  { connection: redisConnection, concurrency: 1 },
)

evaluateModelWorker.on('failed', (job, err) => {
  console.error(`[evaluate-model] Job ${job?.id} failed: ${err.message}`)
})
