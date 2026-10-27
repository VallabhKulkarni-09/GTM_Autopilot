/**
 * rules.ts — RoutingAgent v1 routing logic.
 * ZERO LLM calls. Priority order is enforced: territory → filter → workload → round-robin.
 */

import type { PolicyRule } from '../../domain/db-types.js'
import type { SalesforceUser, RoutingInput, RoutingParameters } from './types.js'

/** Why no owner could be recommended. SCREAMING_SNAKE_CASE reason codes. */
export type RoutingFailure =
  | 'NO_TERRITORY_MATCH'
  | 'NO_REPS_IN_TERRITORY'
  | 'ALL_REPS_UNAVAILABLE'
  | 'ALL_REPS_AT_CAPACITY'

export type RoutingOutcome =
  | { ok: true; params: RoutingParameters }
  | { ok: false; reason: RoutingFailure; queueName: string | null }

type TerritoryMatch = {
  queueName: string
  ownerIds: string[] | null  // null = all owners
}

// Territory rows store their queue + reps in policy_rules.actions:
//   { queue_name: string, owner_ids: string[] | null }   (null = every rep)
function territoryQueue(rule: PolicyRule): string {
  const q = rule.actions?.queue_name
  if (typeof q !== 'string' || !q) throw new Error(`TERRITORY_RULE_INVALID: territory "${rule.name}" (${rule.id}) has no queue_name`)
  return q
}
function territoryOwners(rule: PolicyRule): string[] | null {
  const ids = rule.actions?.owner_ids
  if (ids === null || ids === undefined) return null
  if (!Array.isArray(ids)) throw new Error(`TERRITORY_RULE_INVALID: territory "${rule.name}" (${rule.id}) owner_ids must be a list`)
  return ids as string[]
}

/**
 * Evaluate territory rules against the lead/company and return
 * the matching queue name + owner filter (if any).
 * Returns null when no territory rule matches.
 */
function evaluateTerritoryRules(
  input: RoutingInput
): TerritoryMatch | null {
  const country = ((input.company?.country ?? (input.lead as any)?.country) ?? '').toUpperCase().trim()

  const rules = [...input.territoryPolicyRules].sort((a, b) => a.priority - b.priority)
  for (const rule of rules) {
    const cond = ((rule as any).conditions) as any
    if (!cond) continue

    // Simple territory match: condition.field = 'country', operator = 'in'
    if (cond.field === 'country' && cond.operator === 'in') {
      const values = (cond.values ?? []).map((v: string) => v.toUpperCase())
      if (values.includes(country) || values.includes('*')) {
        return {
          queueName: territoryQueue(rule),
          ownerIds: territoryOwners(rule),
        }
      }
    }

    // Wildcard / catch-all
    if (cond.operator === 'wildcard' || cond.operator === 'all') {
      return {
        queueName: territoryQueue(rule),
        ownerIds: territoryOwners(rule),
      }
    }
  }

  return null
}

/**
 * Main routing logic — must be called in this exact priority order.
 */
export function computeRouting(input: RoutingInput): RoutingOutcome {
  // Step 1: Territory evaluation
  const territory = evaluateTerritoryRules(input)
  if (!territory) return { ok: false, reason: 'NO_TERRITORY_MATCH', queueName: null }

  const { queueName, ownerIds } = territory

  // Step 2: Owners in the territory who are active in Salesforce
  const inTerritory = input.availableOwners.filter(o => o.IsActive && (ownerIds === null || ownerIds.includes(o.Id)))
  if (inTerritory.length === 0) return { ok: false, reason: 'NO_REPS_IN_TERRITORY', queueName }

  // Step 3: Exclude reps marked unavailable (PTO / paused)
  const available = inTerritory.filter(o => o.IsAvailable)
  if (available.length === 0) return { ok: false, reason: 'ALL_REPS_UNAVAILABLE', queueName }

  // Step 4: Exclude reps at or above the org's max open leads
  const eligible = available.filter(o => (input.ownerWorkloads[o.Id] ?? 0) < input.maxOpenLeadsPerRep)
  if (eligible.length === 0) return { ok: false, reason: 'ALL_REPS_AT_CAPACITY', queueName }

  // Step 5: Sort by workload (ascending)
  eligible.sort((a, b) => (input.ownerWorkloads[a.Id] ?? 0) - (input.ownerWorkloads[b.Id] ?? 0))

  // Step 6: Tie-break with round-robin when multiple have equal minimum workload
  const minLoad = input.ownerWorkloads[eligible[0].Id] ?? 0
  const tied = eligible.filter(o => (input.ownerWorkloads[o.Id] ?? 0) === minLoad)

  const currentIndex = (input.routingState as any).current_index ?? input.routingState.counter ?? 0
  const roundRobinIndex = currentIndex % tied.length
  const selected = tied[roundRobinIndex]

  const reasonCodes: string[] = [
    `TERRITORY_${queueName.toUpperCase().replace(/-/g, '_')}`,
  ]
  if (tied.length > 1) {
    reasonCodes.push('ROUND_ROBIN_SELECTED')
  } else {
    reasonCodes.push('LOWEST_WORKLOAD_SELECTED')
  }

  return {
    ok: true,
    params: {
      recommended_owner_id: selected.Id,
      recommended_owner_name: selected.Name,
      queue_name: queueName,
      reason_codes: reasonCodes,
      round_robin_index: roundRobinIndex,
    },
  }
}
