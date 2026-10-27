/**
 * db-types.ts
 * TypeScript types generated from the GTM Autopilot database schema.
 * Source: db/migrations/001–014
 *
 * These are the canonical entity shapes used across the entire application.
 * Never manually define a type that should come from the schema.
 * Re-generate this file whenever migrations change.
 */

// ─── Enums ────────────────────────────────────────────────────────────────────

export type LeadStage =
  | 'new'
  | 'enriching'
  | 'routing'
  | 'in_sequence'
  | 'meeting_booked'
  | 'nurture'
  | 'lost'

export type ExternalProvider =
  | 'salesforce'
  | 'hubspot'
  | 'outreach'
  | 'clearbit'

export type ExternalEntityType = 'lead' | 'company' | 'user'

export type EvidenceSourceType =
  | 'clearbit_person'
  | 'clearbit_company'
  | 'hubspot_contact'
  | 'salesforce_lead'
  | 'salesforce_contact'
  | 'intent_signal'
  | 'manual'
  | 'apollo_enrichment'

export type PolicyRuleType =
  | 'icp_filter'
  | 'territory'
  | 'sla'
  | 'dedup'
  | 're_enrollment'
  | 'routing'
  | 'outcome_detection'
  | 'outreach'

// ── Outcome tracking ──────────────────────────────────────────────────────────

export type OutcomeStatus = 'no_outcome_yet' | 'meeting_booked' | 'no_meeting'

export type SignalType =
  | 'sf_event_meeting'
  | 'lead_status'
  | 'meeting_checkbox'
  | 'opportunity_stage'

export type SignalConfidence = 'primary' | 'supportive'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export type PlayStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'nurture'
  | 'duplicate'

export type EventType =
  // Ingestion
  | 'webhook_received'
  | 'idempotency_check_passed'
  | 'idempotency_check_failed'
  // Enrichment
  | 'enrichment_requested'
  | 'enrichment_succeeded'
  | 'enrichment_failed'
  | 'enrichment_skipped'
  // Deduplication
  | 'dedup_passed'
  | 'dedup_rejected'
  | 'reenrollment_allowed'  // returning lead passed time-window + terminal-status re-enrollment check
  // Agent decisions
  | 'action_proposed'
  | 'action_risk_assessed'
  | 'policy_validated'
  | 'policy_rejected'
  // Execution
  | 'action_execution_started'
  | 'action_execution_succeeded'
  | 'action_execution_failed'
  | 'action_execution_deduplicated'
  // SLA
  | 'sla_checked'
  | 'sla_breached'
  | 'escalation_triggered'
  | 'escalation_sent'
  // AI model (v2, migration 034)
  | 'model_fallback'
  // Human in the loop
  | 'human_review_requested'
  | 'human_approved'
  | 'human_rejected'
  // Play lifecycle
  | 'play_completed'
  | 'play_failed'
  | 'play_paused'
  | 'play_resumed'
  | 'play_marked_nurture'
  | 'play_marked_duplicate'
  // Account matching (before qualification)
  | 'account_match_no_match'
  | 'account_match_found'
  | 'account_match_error'
  // Outcome tracking
  | 'outcome_detected'         // first primary signal — meeting_booked
  | 'late_meeting_detected'    // primary signal after no_meeting was set
  | 'outcome_window_closed'    // attribution window expired with no primary signal

export type ActorType = 'agent' | 'human' | 'system' | 'sla_timer' | 'webhook' | 'outcome_poller'

export type EventStatus = 'success' | 'failed' | 'skipped'

export type ActionExecutionStatus =
  | 'proposed'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'deduplicated'

export type ConnectorName = 'salesforce' | 'hubspot' | 'outreach' | 'clearbit' | 'salesloft' | 'zoominfo' | 'apollo'


export type ConnectorHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

// ─── Table Row Types ──────────────────────────────────────────────────────────

export type Organization = {
  id: string
  name: string
  slug: string
  domain: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type Lead = {
  id: string
  organization_id: string
  email: string
  first_name: string | null
  last_name: string | null
  title: string | null
  phone: string | null
  company_id: string | null
  stage: LeadStage
  form_submitted_at: string       // ISO timestamp — SLA clock starts here
  source: string
  raw_payload: Record<string, unknown> | null
  // Qualification fields (added in migration 014)
  is_duplicate: boolean              // true = lead matched an existing email in this org
  is_icp_fit: boolean | null         // null = not yet qualified
  icp_score: number | null           // 0–100
  icp_tier: 'tier_1' | 'tier_2' | 'not_icp' | null
  // Setup wizard (migration 031)
  is_test: boolean                   // sent from the setup page; excluded from metrics and duplicate checks
  removed_at: string | null          // test lead removed by DELETE /api/test-lead (rows are never deleted)
  created_at: string
  updated_at: string
}

export type Company = {
  id: string
  organization_id: string
  name: string | null
  domain: string | null
  industry: string | null
  sub_industry: string | null
  employee_count: number | null
  employee_range: string | null
  annual_revenue: number | null   // USD cents
  country: string | null
  state: string | null
  city: string | null
  founded_year: number | null
  tech_stack: string[] | null
  funding_stage: string | null
  raw_clearbit: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export type ExternalIdentity = {
  id: string
  organization_id: string
  entity_type: ExternalEntityType
  entity_id: string
  provider: ExternalProvider
  external_id: string
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export type Evidence = {
  id: string
  organization_id: string
  lead_id: string | null
  company_id: string | null
  source_type: EvidenceSourceType
  source_id: string | null
  data: Record<string, unknown>
  is_current: boolean
  collected_at: string
  expires_at: string | null
  created_at: string
  updated_at: string
}

export type PolicyRule = {
  id: string
  organization_id: string
  rule_type: PolicyRuleType
  name: string
  description: string | null
  version: number
  is_active: boolean
  priority: number
  conditions: Record<string, unknown>
  actions: Record<string, unknown> | null
  effective_from: string
  effective_until: string | null
  created_at: string
  updated_at: string
}

export type ActionRiskRegistry = {
  id: string
  organization_id: string
  action_type: string
  risk_level: RiskLevel
  max_risk_score: number          // 0.000 – 1.000
  requires_human_review: boolean
  required_policy_ids: string[] | null
  description: string | null
  created_at: string
  updated_at: string
}

export type PlayInstance = {
  id: string
  organization_id: string
  lead_id: string
  play_type: string
  status: PlayStatus
  workflow_run_id: string | null
  current_step: number
  first_touch_deadline: string    // form_submitted_at + sla_minutes
  first_touch_at: string | null
  sla_breached: boolean
  sla_breached_at: string | null
  assigned_owner_id: string | null
  assigned_owner_name: string | null
  sequence_id: string | null
  enrolled_at: string | null
  failure_reason: string | null
  // Outcome tracking columns (migration 018)
  outcome_status: OutcomeStatus              // default: 'no_outcome_yet'
  outcome_detected_at: string | null         // set on first primary signal
  attribution_window_days: number            // captured from policy at play start — IMMUTABLE after creation
  late_meeting_flag: boolean                 // primary signal after no_meeting cutoff
  meetings_count_in_window: number           // total primary signals within window
  // Human review + escalation (migrations 015, 030)
  pending_approval_since: string | null
  review_kind: ReviewKind | null
  review_context: ReviewContext | null
  review_decision: ReviewDecision | null
  review_decided_at: string | null
  review_decided_by: string | null
  escalated_at: string | null
  escalation_reason: string | null
  // Setup wizard (migration 031) — copied from the lead at creation
  is_test: boolean
  removed_at: string | null
  created_at: string
  updated_at: string
}

export type ReviewKind = 'routing' | 'sequence'

/** What a reviewer needs to decide; written by the executor's request_human_review. */
export type ReviewContext = {
  reason_codes: string[]
  queue_name: string | null
  recommended_owner_id: string | null    // Salesforce user id, when the agent had a suggestion
  recommended_owner_name: string | null
  sequence_name?: string | null          // sequence reviews
}

/** The human's decision; stored on play_instance and passed to the graph as the resume value. */
export type ReviewDecision = {
  decision: 'approved' | 'rejected'
  kind: ReviewKind
  owner_id: string | null       // Salesforce user id (routing approvals)
  owner_name: string | null
  note: string | null
  actor_user_id: string
  decided_at: string
}

// ── OutcomeSignal ─────────────────────────────────────────────────────────────
// Append-only. Never UPDATE. Never DELETE.
// sf_raw_payload stores full raw SF payload for replay (same spirit as decision_snapshot).
// UNIQUE on (organization_id, play_instance_id, external_event_id) for idempotency.

export type OutcomeSignal = {
  id: string
  organization_id: string
  play_instance_id: string
  lead_id: string
  signal_type: SignalType
  confidence: SignalConfidence
  external_event_id: string
  sf_raw_payload: Record<string, unknown>
  detected_at: string
  // NO updated_at — append-only
}

/**
 * The decision_snapshot is stored on EVERY event_log row.
 * It captures the full state at the moment of the decision,
 * enabling exact replay and simulation.
 */
export type DecisionSnapshot = {
  lead: Lead
  company: Company | null
  policies: PolicyRule[]
  ownerWorkloads: Record<string, number>  // owner_id → active lead count
  evidenceIds: string[]
  agentName: string
  agentVersion: string
  promptVersion: string | null            // null for rule-based agents
  modelName: string | null                // null for rule-based agents
  // Optional context fields appended by specific nodes
  icpPolicy?: { id: string; version: number }  // set by qualify: the icp_filter policy that scored the lead
  outreachPolicy?: { id: string; version: number }  // set by first-touch: the outreach policy that chose the sequence
  // set by qualify when an AI model is configured + switched on (v2): which model decided, or why it did not
  modelContext?: {
    outcome: 'model' | 'hard_gate' | 'fallback'
    provider: string
    model: string
    reportedModel: string | null
    modelDigest: string | null
    promptVersion: string
    temperature: 0
    evaluationId: string | null
    fallbackReason: string | null
    rulesTier: 'tier_1' | 'tier_2' | 'not_icp' | null
    modelTier: 'tier_1' | 'tier_2' | 'not_icp' | null
  }
  // set by route when the AI routing agent is switched on
  routingModelContext?: {
    outcome: 'model' | 'not_needed' | 'fallback'
    provider: string
    model: string
    reportedModel: string | null
    modelDigest: string | null
    promptVersion: string
    temperature: 0
    evaluationId: string | null
    fallbackReason: string | null
    countryRaw: string | null
    countryCode: string | null
  }
  // set by route: everything besides lead/company/policies/workloads the routing decision read (enables replay)
  routingContext?: {
    owners: Array<{ Id: string; Name: string; Email: string; IsActive: boolean; IsAvailable: boolean }>
    roundRobinCounter: number
    maxOpenLeadsPerRep: number
  }
  reenrollmentContext?: {
    priorPlayStatus: string
    priorPlayAge:    string   // human-readable, e.g. "95d"
    allowAfterDays:  number
  }
  humanReviewContext?: {
    actorUserId: string
    decision:    'approved' | 'rejected'
    playStateAtDecision: Record<string, unknown>
  }
}

export type EventLog = {
  id: string
  organization_id: string
  workflow_run_id: string | null
  play_instance_id: string | null
  lead_id: string | null
  event_type: EventType
  actor_type: ActorType
  actor_id: string | null
  agent_version: string | null
  model_provider: string | null
  model_name: string | null
  prompt_version: string | null
  decision_snapshot: DecisionSnapshot     // NEVER null
  proposed_action: Record<string, unknown> | null
  candidate_actions: Record<string, unknown>[] | null
  policy_rule_id: string | null
  policy_name: string | null
  policy_passed: boolean | null
  policy_decision: Record<string, unknown> | null
  external_system: string | null
  external_id: string | null
  idempotency_key: string | null
  event_status: EventStatus
  error_code: string | null
  error_message: string | null
  error_raw: Record<string, unknown> | null
  duration_ms: number | null
  occurred_at: string
  created_at: string
  // NO updated_at — this table is immutable
}

export type ActionExecutionState = {
  id: string
  organization_id: string
  idempotency_key: string
  play_instance_id: string | null
  lead_id: string | null
  action_type: string
  status: ActionExecutionStatus
  proposed_at: string | null
  started_at: string | null
  completed_at: string | null
  external_system: string | null
  external_id: string | null
  error_code: string | null
  error_message: string | null
  agent_name: string | null
  agent_version: string | null
  created_at: string
  updated_at: string
}

export type ConnectorConfig = {
  id: string
  organization_id: string
  connector_name: ConnectorName
  is_active: boolean
  credentials_vault_key: string
  config: Record<string, unknown> | null
  last_health_check_at: string | null
  health_status: ConnectorHealthStatus
  health_latency_ms: number | null
  health_error: string | null
  created_at: string
  updated_at: string
}

export type RoutingState = {
  id: string
  organization_id: string
  queue_name: string
  counter: number
  last_assigned_owner_id: string | null
  last_assigned_at: string | null
  created_at: string
  updated_at: string
}

// ─── Insert Types (omit DB-generated fields) ─────────────────────────────────

export type InsertOrganization = Omit<Organization, 'id' | 'created_at' | 'updated_at'>
export type InsertLead = Omit<Lead, 'id' | 'created_at' | 'updated_at'>
export type InsertCompany = Omit<Company, 'id' | 'created_at' | 'updated_at'>
export type InsertExternalIdentity = Omit<ExternalIdentity, 'id' | 'created_at' | 'updated_at'>
export type InsertEvidence = Omit<Evidence, 'id' | 'created_at' | 'updated_at'>
export type InsertPolicyRule = Omit<PolicyRule, 'id' | 'created_at' | 'updated_at'>
export type InsertActionRiskRegistry = Omit<ActionRiskRegistry, 'id' | 'created_at' | 'updated_at'>
export type InsertPlayInstance = Omit<PlayInstance, 'id' | 'created_at' | 'updated_at'>
export type InsertEventLog = Omit<EventLog, 'id' | 'occurred_at' | 'created_at'>   // no updated_at to omit
export type InsertActionExecutionState = Omit<ActionExecutionState, 'id' | 'created_at' | 'updated_at'>
export type InsertConnectorConfig = Omit<ConnectorConfig, 'id' | 'created_at' | 'updated_at'>
export type InsertRoutingState = Omit<RoutingState, 'id' | 'created_at' | 'updated_at'>
// OutcomeSignal is append-only — omit id and detected_at (DB defaults)
export type InsertOutcomeSignal = Omit<OutcomeSignal, 'id' | 'detected_at'>

// ─── Update Types (all fields optional except ID) ────────────────────────────

export type UpdateLead = Partial<Omit<Lead, 'id' | 'organization_id' | 'created_at'>>
export type UpdateCompany = Partial<Omit<Company, 'id' | 'organization_id' | 'created_at'>>
export type UpdatePlayInstance = Partial<Omit<PlayInstance, 'id' | 'organization_id' | 'lead_id' | 'created_at'>>
export type UpdateActionExecutionState = Partial<Omit<ActionExecutionState, 'id' | 'organization_id' | 'idempotency_key' | 'created_at'>>
export type UpdateConnectorConfig = Partial<Omit<ConnectorConfig, 'id' | 'organization_id' | 'connector_name' | 'created_at'>>
export type UpdateRoutingState = Partial<Omit<RoutingState, 'id' | 'organization_id' | 'queue_name' | 'created_at'>>
