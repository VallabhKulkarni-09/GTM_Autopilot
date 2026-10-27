/**
 * timeline-dto.ts — what GET /api/leads/:id/timeline returns for one event_log row.
 *
 * Only the fields the lead page reads (dashboard/src/lib/describe-event.ts). Deliberately left out:
 * organization_id, error_raw (raw provider responses), candidate_actions, and from the snapshot the
 * full lead (raw form payload), rep list with emails, owner workloads and review state. The full row
 * stays in event_log for audit and replay.
 */
import type { EventLog } from '../../domain/db-types.js'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {})
const pick = (o: Obj, keys: string[]): Obj => {
  const out: Obj = {}
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k]
  return out
}

export type TimelineSnapshotDto = {
  agentName?: string
  agentVersion?: string
  promptVersion?: string | null
  modelName?: string | null
  company?: { name?: string | null; domain?: string | null; industry?: string | null; employee_count?: number | null; country?: string | null } | null
  policies?: Array<{ id: string; rule_type: string; name: string; version: number }>
  evidenceIds?: string[]
  icpPolicy?: { id: string; version: number }
  outreachPolicy?: { id: string; version: number }
  enrichmentSkipReason?: string
  matchedOpportunityId?: string
  reenrollmentContext?: Obj
  modelContext?: Obj
  routingModelContext?: Obj
}

export type TimelineEventDto = Pick<EventLog,
  | 'id' | 'occurred_at' | 'event_type' | 'actor_type' | 'actor_id' | 'agent_version' | 'model_name' | 'prompt_version'
  | 'workflow_run_id' | 'play_instance_id' | 'proposed_action' | 'policy_name' | 'policy_passed' | 'policy_decision'
  | 'external_system' | 'external_id' | 'idempotency_key' | 'event_status' | 'error_code' | 'error_message' | 'duration_ms'
> & { decision_snapshot: TimelineSnapshotDto }

export function toTimelineEventDto(row: EventLog): TimelineEventDto {
  const s = obj(row.decision_snapshot)
  const snapshot: TimelineSnapshotDto = pick(s, [
    'agentName', 'agentVersion', 'promptVersion', 'modelName', 'evidenceIds', 'icpPolicy', 'outreachPolicy',
    'enrichmentSkipReason', 'matchedOpportunityId', 'reenrollmentContext',
  ]) as TimelineSnapshotDto
  if (s.company !== undefined) {
    snapshot.company = s.company === null ? null : pick(obj(s.company), ['name', 'domain', 'industry', 'employee_count', 'country'])
  }
  if (Array.isArray(s.policies)) {
    snapshot.policies = s.policies.map(p => pick(obj(p), ['id', 'rule_type', 'name', 'version'])) as TimelineSnapshotDto['policies']
  }
  if (s.modelContext !== undefined) {
    snapshot.modelContext = pick(obj(s.modelContext), [
      'outcome', 'provider', 'model', 'reportedModel', 'modelDigest', 'promptVersion', 'temperature', 'evaluationId',
      'fallbackReason', 'rulesTier', 'modelTier',
    ])
  }
  if (s.routingModelContext !== undefined) {
    snapshot.routingModelContext = pick(obj(s.routingModelContext), [
      'outcome', 'provider', 'model', 'reportedModel', 'modelDigest', 'promptVersion', 'evaluationId', 'fallbackReason', 'countryRaw', 'countryCode',
    ])
  }
  return {
    id: row.id, occurred_at: row.occurred_at, event_type: row.event_type, actor_type: row.actor_type, actor_id: row.actor_id,
    agent_version: row.agent_version, model_name: row.model_name, prompt_version: row.prompt_version,
    workflow_run_id: row.workflow_run_id, play_instance_id: row.play_instance_id, proposed_action: row.proposed_action,
    policy_name: row.policy_name, policy_passed: row.policy_passed, policy_decision: row.policy_decision,
    external_system: row.external_system, external_id: row.external_id, idempotency_key: row.idempotency_key,
    event_status: row.event_status, error_code: row.error_code, error_message: row.error_message, duration_ms: row.duration_ms,
    decision_snapshot: snapshot,
  }
}
