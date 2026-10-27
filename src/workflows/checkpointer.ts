/**
 * checkpointer.ts — durable LangGraph checkpoints in Postgres.
 *
 * A play paused for human review must survive worker restarts and deploys, so the
 * graph state lives in Postgres (PostgresSaver), never in memory.
 *
 * - Connection: SUPABASE_DB_URL (the same direct/session-pooler URL db/migrate.js uses).
 *   Missing → throws CHECKPOINTER_NOT_CONFIGURED; there is no in-memory fallback.
 * - Tables: schema "langgraph" (created by setup(), idempotent). Kept out of "public" so
 *   Supabase's REST API never exposes them. Rows are keyed by thread_id = the play's
 *   workflow_run_id (a UUID), and are only read by the worker for that exact play.
 * - Only the worker process needs this; the API reads play_instance, not checkpoints.
 */

import pg from 'pg'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import type { BaseCheckpointSaver } from '@langchain/langgraph'

export const CHECKPOINT_SCHEMA = 'langgraph'

let saver: Promise<BaseCheckpointSaver> | null = null

function sslFor(url: string): false | { rejectUnauthorized: false } {
  // Supabase requires TLS; a local Postgres (tests, docker) usually has none.
  return /@(localhost|127\.0\.0\.1|postgres)(:|\/)/.test(url) || /sslmode=disable/.test(url)
    ? false
    : { rejectUnauthorized: false }
}

/** Creates a Postgres checkpointer for `url` and runs its table setup. */
export async function createPostgresCheckpointer(url: string): Promise<PostgresSaver> {
  const pool = new pg.Pool({ connectionString: url, ssl: sslFor(url), max: 5 })
  const s = new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA })
  await s.setup()
  return s
}

/** The process-wide checkpointer. Throws if SUPABASE_DB_URL is not set. */
export function getCheckpointer(): Promise<BaseCheckpointSaver> {
  if (!saver) {
    const url = process.env.SUPABASE_DB_URL
    if (!url) {
      throw new Error(
        'CHECKPOINTER_NOT_CONFIGURED: set SUPABASE_DB_URL so paused plays are stored durably in Postgres.'
      )
    }
    saver = createPostgresCheckpointer(url).catch(err => {
      saver = null // do not cache a failed setup; the next job retries
      throw err
    })
  }
  return saver
}

/** Tests only: use a specific checkpointer (e.g. MemorySaver) instead of Postgres. */
export function setCheckpointerForTests(s: BaseCheckpointSaver | null): void {
  saver = s ? Promise.resolve(s) : null
}
