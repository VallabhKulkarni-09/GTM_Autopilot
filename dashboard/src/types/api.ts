export type LeadStage = 'new' | 'enriching' | 'routing' | 'in_sequence' | 'meeting_booked' | 'nurture' | 'lost'

/** Outcome status of a play's attribution window (migration 018). */
export type OutcomeStatus = 'no_outcome_yet' | 'meeting_booked' | 'no_meeting'

export interface OverviewMetrics {
  currentPeriod: {
    touchedUnder15MinPct: number;
    avgFirstTouchMin: number;
    slaBreaches: number;
    activePlays: number;
    playsCompleted: number;
    totalQualified: number;
    /**
     * Outcome-based meeting rate (distinct from playsCompleted above).
     * = meeting_booked plays / (meeting_booked + no_meeting) plays.
     * Excludes no_outcome_yet plays from denominator.
     * null = no plays have closed attribution windows yet.
     */
    meeting_rate: number | null;
  };
  priorPeriod: {
    touchedUnder15MinPct: number;
    playsCompleted: number;
    totalQualified: number;
  };
}

export interface SpeedToLeadDistribution {
  buckets: {
    under5: { count: number; pct: number };
    under15: { count: number; pct: number };
    under30: { count: number; pct: number };
    under60: { count: number; pct: number };
    over60: { count: number; pct: number };
  };
  sdrStats: {
    name: string;
    medianFirstTouchMin: number;
    under15MinPct: number;
    playsCompleted: number;
  }[];
  total: number;
}

export interface Lead {
  id: string;
  email?: string;
  company?: string;
  name: string;
  title: string;
  stage: LeadStage;
  timeToFirstTouchMin: number | null;
  assignedTo: string | null;
  formSubmittedAt: string;
  /** Sent from the setup page; never counted in metrics. */
  isTest?: boolean;
}

export interface PaginatedLeads {
  data: Lead[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Current play state returned in GET /api/leads/:id response.
 * Includes outcome tracking fields added in migration 018.
 */
export interface PlayState {
  id: string;
  status: PlayStatus;
  current_step: number;
  sla_breached: boolean;
  first_touch_at: string | null;
  first_touch_deadline: string | null;
  workflow_run_id: string | null;
  // Outcome tracking (migration 018)
  outcome_status: OutcomeStatus;
  outcome_detected_at: string | null;
  late_meeting_flag: boolean;
  meetings_count_in_window: number;
  attribution_window_days: number;
}

/** Mirrors `PlayStatus` in src/domain/db-types.ts (migration 008). */
export type PlayStatus = 'running' | 'completed' | 'failed' | 'paused' | 'nurture' | 'duplicate'

/** Mirrors `leads.icp_tier`. */
export type FitTier = 'tier_1' | 'tier_2' | 'not_icp'

/**
 * Mirrors `EventType` in src/domain/db-types.ts (the `event_type` Postgres enum,
 * migrations 009, 017, 018, 024). Keep in sync: describe-event.ts is exhaustive over it.
 */
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
  | 'reenrollment_allowed'
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
  // Account matching
  | 'account_match_no_match'
  | 'account_match_found'
  | 'account_match_error'
  // Outcome tracking
  | 'outcome_detected'
  | 'late_meeting_detected'
  | 'outcome_window_closed';

export type ActorType = 'agent' | 'human' | 'system' | 'sla_timer' | 'webhook' | 'outcome_poller'
export type EventStatus = 'success' | 'failed' | 'skipped'

/** One row of GET /api/leads/:id/timeline (event_log). Only the fields the dashboard reads. */
export interface ApiTimelineEvent {
  id: string;
  occurred_at: string;
  event_type: EventType;
  actor_type: ActorType;
  actor_id: string | null;
  agent_version: string | null;
  model_name: string | null;
  prompt_version: string | null;
  workflow_run_id: string | null;
  play_instance_id: string | null;
  /** Trimmed server-side (src/routes/api/timeline-dto.ts): agent/model, company facts, policy refs, evidence ids. */
  decision_snapshot: Record<string, unknown> | null;
  proposed_action: Record<string, unknown> | null;
  policy_name: string | null;
  policy_passed: boolean | null;
  policy_decision: Record<string, unknown> | null;
  external_system: string | null;
  external_id: string | null;
  idempotency_key: string | null;
  event_status: EventStatus;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
}

/** GET /api/leads/:id */
export interface LeadDetail {
  id: string;
  email: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  phone: string | null;
  stage: LeadStage;
  source: string | null;
  formSubmittedAt: string;
  isDuplicate: boolean;
  isIcpFit: boolean | null;
  icpScore: number | null;
  icpTier: FitTier | null;
  isTest: boolean;
  createdAt: string;
}

export interface ConnectorHealth {
  name: 'hubspot' | 'salesforce' | 'apollo';
  status: 'connected' | 'needs_attention' | 'not_connected';
  details: Record<string, unknown>;
  lastChecked: string | null;
}

export interface PolicyRule {
  id: string;
  rule_type: string;
  name: string;
  conditions_summary: string;
  queue_assigned?: string;
  sla_minutes?: number;
}

/** GET /api/setup (src/routes/api/setup.ts) */
export type SetupStepKey = 'hubspot' | 'salesforce' | 'apollo' | 'reps' | 'ideal_customer' | 'outreach' | 'test_lead'
export interface SetupStep {
  key: SetupStepKey;
  required: boolean;
  done: boolean;
  facts: Record<string, string | number | boolean | null>;
}
export interface SetupStatus {
  completedAt: string | null;
  canFinish: boolean;
  steps: SetupStep[];
}

/** GET /api/test-lead (src/routes/api/test-lead.ts) */
export interface TestLeadSummary {
  id: string;
  name: string;
  email: string;
  stage: LeadStage;
  fit: FitTier | null;
  submittedAt: string;
  playStatus: PlayStatus | null;
  owner: string | null;
}

// ─── AI model (GET /api/ai-model) ─────────────────────────────────────────────
export type AiModelProvider = 'ollama' | 'openai_compatible' | 'openai' | 'openrouter' | 'anthropic' | 'gemini'

export interface AiModelSettings {
  configured: boolean
  provider: AiModelProvider | null
  baseUrl: string | null
  model: string | null
  hasApiKey: boolean
  qualificationAgentEnabled: boolean
  routingAgentEnabled: boolean
  dataLeavesMachine: boolean
  consentAt: string | null
  lastTest: { ok: boolean; at: string } | null
  suggestedOllamaUrl: string | null
}

// ─── AI model test leads (GET /api/ai-model/evaluations/latest) ───────────────

export interface AiModelEvaluation {
  id: string
  status: 'running' | 'completed' | 'failed'
  provider: string
  model: string
  modelDigest: string | null
  promptVersion: string
  agentVersion: string
  datasetVersion: string
  summary: {
    done?: number
    agreed: number
    total: number
    injection?: { agreed: number; total: number }
    reviews?: number
    fallbacks?: number
    hardGates?: number
    errors?: number
    avgModelLatencyMs?: number | null
    baseline?: { agreed: number; total: number }
    routing?: { agreed: number; total: number; asked: number; fallbacks: number; baseline: { agreed: number; total: number } }
  } | null
  error: string | null
  startedAt: string
  completedAt: string | null
  misses: Array<{ caseId: string; description: string; expected: FitTier; actual: FitTier | null; outcome: string; review: boolean; fallbackReason: string | null }>
  routingMisses?: Array<{ caseId: string; description: string; outcome: string; countryRaw: string | null; countryCode: string | null; fallbackReason: string | null }>
}

export interface AiModelEvaluationState {
  evaluation: AiModelEvaluation | null
  matchesCurrentModel: boolean
  routingMatchesCurrentModel: boolean
  qualificationAgentEnabled: boolean
  routingAgentEnabled: boolean
}
