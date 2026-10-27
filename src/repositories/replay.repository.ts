/**
 * replay.repository.ts — reads recorded agent decisions for the replay simulator.
 * Read-only. Every query is scoped by organization_id first.
 */
import { getDb } from '../db/client.js'
import type { EventLog } from '../domain/db-types.js'

export const REPLAY_MAX_EVENTS = 1000

/** `action_proposed` events written by the given agents, oldest first. */
export async function listAgentProposals(
  organizationId: string,
  agentNames: string[],
  opts: { since?: string; limit: number },
): Promise<EventLog[]> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > REPLAY_MAX_EVENTS) {
    throw new Error(`REPLAY_LIMIT_INVALID: limit must be a whole number between 1 and ${REPLAY_MAX_EVENTS}`)
  }
  let q = getDb()
    .from('event_log')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('event_type', 'action_proposed')
    .in('actor_id', agentNames)
  if (opts.since) q = q.gte('occurred_at', opts.since)
  const { data, error } = await q.order('occurred_at', { ascending: true }).limit(opts.limit)
  if (error) throw new Error(`listAgentProposals failed: ${error.message}`)
  return (data ?? []) as EventLog[]
}
