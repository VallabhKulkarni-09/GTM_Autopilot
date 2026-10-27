/**
 * index.ts — RoutingAgent v1
 * Rule-based. Zero LLM calls.
 * When no territory matches or all owners at capacity → returns 'request_human_review'.
 */

import { computeRouting } from './rules.js'
import type { RoutingInput } from './types.js'
import type { ProposedAction } from '../qualification/types.js'

export class RoutingAgent {
  readonly name = 'routing-agent'
  readonly version = '1.1.0'

  /** Primary API — used by the rule-based v1 pipeline */
  run(input: import('./types.js').RoutingInput): ProposedAction {
    const result = computeRouting(input)

    // No territory match, nobody available, or all at capacity → escalate to human
    if (!result.ok) {
      return {
        type: 'request_human_review',
        parameters: {
          queue_name: result.queueName ?? 'unassigned',
          reason_codes: input.availableOwners.length === 0 ? ['OWNER_LIST_EMPTY'] : [result.reason],
          max_open_leads_per_rep: input.maxOpenLeadsPerRep,
        },
        decisionRiskScore: 0.0,
        rawConfidence: 1.0,
      }
    }

    return {
      type: 'assign_owner',
      parameters: { ...result.params, max_open_leads_per_rep: input.maxOpenLeadsPerRep },
      decisionRiskScore: 0.0,
      rawConfidence: 1.0,
    }
  }

  /** Async execute() alias — compatible with LangGraph node interface */
  async execute(input: any, _context?: any): Promise<ProposedAction> {
    return this.run(input)
  }
}

export const routingAgent = new RoutingAgent()
