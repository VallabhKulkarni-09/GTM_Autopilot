/**
 * describe-event.ts — turns event_log rows into plain-language timeline entries.
 *
 * `describeEvent` switches over every `EventType` (exhaustive: adding a type to the union
 * without a case is a compile error). An event type the API sends that this build does not
 * know is shown explicitly as "Unrecognised step", never hidden or guessed.
 *
 * Technical facts (event type, codes, IDs, policy versions) go into `developer`, which the
 * timeline only shows when "Developer details" is switched on.
 */

import type {
  ActorType, ApiTimelineEvent, EventStatus, EventType, FitTier, LeadDetail, LeadStage, PlayState,
} from '@/types/api'
import { escalationReason } from '@/lib/review-labels'

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface DevField { label: string; value: string }

export interface DescribedEvent {
  id: string
  at: string
  title: string
  /** One plain sentence explaining what happened, or null when the title says it all. */
  detail: string | null
  reasons: string[]
  tone: Tone
  outcome: EventStatus
  actor: string
  developer: DevField[]
}

// ── Fit ─────────────────────────────────────────────────────────────────────────

export const FIT_LABELS: Record<FitTier, string> = {
  tier_1: 'Great fit',
  tier_2: 'Good fit',
  not_icp: 'Not a fit',
}

export function fitLabel(tier: string | null | undefined): string | null {
  return tier && tier in FIT_LABELS ? FIT_LABELS[tier as FitTier] : null
}

// ── Reason codes ────────────────────────────────────────────────────────────────

const REASONS: Record<string, string> = {
  // AI model (src/agents/qualification/llm.ts)
  MODEL_DECISION:            'Decided by the AI model',
  MODEL_RULES_DISAGREE:      'The AI model and your rules disagree, so a teammate decides',
  MODEL_FALLBACK_RULES:      'Decided by the rules (the AI model could not be used)',
  ICP_INDUSTRY_MATCH:        'Industry matches',
  ICP_REGION_MATCH:          'Country matches',
  NOT_SENIOR_TITLE:          'Job title is not senior',
  SUSPICIOUS_FORM_CONTENT:   'Form text tried to instruct the AI and was ignored',
  MODEL_COUNTRY_NORMALISED:  'The AI model read the company\'s country',
  MODEL_COUNTRY_UNKNOWN:     'The AI model could not tell which country the company is in',
  // Fit scoring (src/agents/qualification/rules.ts)
  DISQUALIFIED_FREE_EMAIL_PROVIDER: 'Uses a personal email address',
  DISQUALIFIED_TOO_SMALL:           'Company is below the smallest size you accept',
  ICP_COMPANY_SIZE_IN_RANGE:        'Company size is in your ideal range',
  ICP_COMPANY_SIZE_NEAR_RANGE:      'Company is a little smaller than ideal',
  ICP_COMPANY_SIZE_LARGE:           'Company is larger than your ideal range',
  NOT_ICP_TOO_SMALL:                'Company is too small to earn size points',
  ENRICHMENT_MISSING_COMPANY_SIZE:  'Company size unknown',
  ICP_INDUSTRY_SAAS:                'Industry matches',
  NOT_ICP_INDUSTRY_MISMATCH:        'Industry is not on your list',
  ENRICHMENT_MISSING_INDUSTRY:      'Industry unknown',
  ICP_REGION_NA:                    'Country matches',
  ICP_REGION_EMEA_APAC:             'Country matches',
  NOT_ICP_REGION_EXCLUDED:          'Country is not on your list',
  ENRICHMENT_MISSING_REGION:        'Country unknown',
  ICP_HIGH_INTENT_FORM:             'Came from a high-intent form',
  ICP_SENIOR_TITLE:                 'Job title matches',
  ENRICHMENT_MISSING_ALL_FIELDS:    'No company or form details available',
  NOT_ICP_SCORE_TOO_LOW:            'Score is below the "Good fit" level',
  // Routing (src/agents/routing/rules.ts, account-match.ts, human-review.ts)
  ROUND_ROBIN_SELECTED:             'Shared evenly between reps',
  LOWEST_WORKLOAD_SELECTED:         'Rep with the fewest open leads',
  OWNER_LIST_EMPTY:                 'No reps have been imported yet',
  NO_TERRITORY_MATCH:               'No territory covers this lead’s country',
  NO_REPS_IN_TERRITORY:             'The matching territory has no reps',
  ALL_REPS_UNAVAILABLE:             'Every rep in the territory is away',
  ALL_REPS_AT_CAPACITY:             'Every rep in the territory is at their lead limit',
  EXISTING_ACTIVE_DEAL:             'Company has an open deal in Salesforce',
  EXISTING_ACCOUNT_OWNER:           'Company already has an account owner in Salesforce',
  HUMAN_ASSIGNED:                   'Rep chosen by a teammate',
  // Outreach (src/policies/outreach-policy.ts, first-touch.ts)
  OUTREACH_ENROLL:                  'Sequence chosen for this fit level',
  MANUAL_FOLLOW_UP_FOR_TIER:        'This fit level is followed up by hand',
  ACTIVE_DEAL_OWNER_FOLLOW_UP:      'The deal owner follows up by hand',
  HUMAN_REJECTED_SEQUENCE:          'A teammate chose not to use the sequence',
  OUTREACH_TIER_NOT_SET:            'No sequence chosen for this fit level',
  OUTREACH_EMAIL_ACCOUNT_NOT_SET:   'No sending mailbox chosen',
  OUTREACH_TIER_UNKNOWN:            'The lead has no fit level to pick a sequence',
  OUTREACH_POLICY_MISSING:          'Outreach is not set up',
  OUTREACH_POLICY_INVALID:          'Outreach settings need to be picked again',
}

/** Plain text for a reason code. Unknown codes are shown humanised rather than dropped. */
export function reasonText(code: string): string {
  if (REASONS[code]) return REASONS[code]
  if (code.startsWith('TERRITORY_')) return `Territory: ${humanise(code.slice('TERRITORY_'.length))}`
  return humanise(code)
}

function humanise(code: string): string {
  const s = code.toLowerCase().replace(/_/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Error codes ─────────────────────────────────────────────────────────────────

const ERRORS: Record<string, string> = {
  NO_SEP_CONNECTOR_AVAILABLE:  'Apollo is not connected, so no sequence was started.',
  OUTREACH_POLICY_MISSING:     'Outreach is not set up. Choose sequences on the Outreach page.',
  OUTREACH_POLICY_INVALID:     'Outreach settings need to be picked again on the Outreach page.',
  OUTREACH_TIER_NOT_SET:       'No sequence is chosen for this fit level. Pick one on the Outreach page.',
  OUTREACH_EMAIL_ACCOUNT_NOT_SET: 'No sending mailbox is chosen. Pick one on the Outreach page.',
  OUTREACH_TIER_UNKNOWN:       'The lead has no fit level, so no sequence could be picked.',
  ICP_POLICY_MISSING:          'Ideal customer settings are missing. Open the Ideal customer page and save them.',
  CHECKPOINT_NOT_FOUND:        'The paused play could not be found to continue it.',
  RESUME_FAILED:               'The play could not continue after the review.',
  LEAD_EMAIL_MISSING:          'The lead has no email address.',
  AP_AUTH_FAILED:              'Apollo did not accept the API key.',
  AP_INSUFFICIENT_SCOPE:       'The Apollo key is missing a permission.',
  AP_RATE_LIMITED:             'Apollo said too many requests were made. It will be retried.',
  AP_ENRICH_FAILED:            'Apollo could not look up the company.',
  AP_CONTACT_FAILED:           'Apollo could not find or create the contact.',
  AP_SEQUENCE_FAILED:          'Apollo did not add the contact to the sequence.',
  AP_NOT_CONNECTED:            'Apollo is not connected.',
  AP_NETWORK_ERROR:            'Apollo could not be reached.',
  SF_AUTH_FAILED:              'Salesforce did not accept the connection details.',
  SF_TOKEN_REFRESH_FAILED:     'Salesforce did not issue an access token.',
  SF_LEAD_CREATE_FAILED:       'The Lead could not be created in Salesforce.',
  SF_LEAD_UPDATE_FAILED:       'The Lead could not be updated in Salesforce.',
  SF_LEAD_ASSIGN_FAILED:       'The Lead owner could not be set in Salesforce.',
  SF_LEAD_QUERY_FAILED:        'Leads could not be read from Salesforce.',
  SF_TASK_CREATE_FAILED:       'The follow-up Task could not be created in Salesforce.',
  SF_REQUEST_FAILED:           'Salesforce could not be reached.',
  SF_UNKNOWN_ERROR:            'Salesforce returned an unexpected error.',
}

const MODEL_FALLBACK: Record<string, string> = {
  MODEL_TIMEOUT: 'The AI model took too long to answer.',
  MODEL_UNREACHABLE: 'The AI model could not be reached.',
  MODEL_BUSY: 'The AI model was busy with other leads.',
  MODEL_OUTPUT_INVALID: 'The AI model gave an answer in the wrong format twice.',
  MODEL_CHANGED_SINCE_EVALUATION: 'The AI model changed since it was tested. Run the test leads again in Settings.',
  MODEL_EVALUATION_OUTDATED: 'The app was updated since the AI model was tested. Run the test leads again in Settings.',
  MODEL_AUTH_FAILED: 'The AI provider did not accept the API key.',
  MODEL_RATE_LIMITED: 'The AI provider was limiting requests.',
  MODEL_QUOTA_EXCEEDED: 'The AI provider account has no credits left.',
}
export function modelFallbackText(code: string | null | undefined): string {
  return (code && MODEL_FALLBACK[code]) || 'The AI model\'s answer could not be used.'
}

export function errorText(code: string | null | undefined): string {
  return (code && ERRORS[code]) || 'Something went wrong. Turn on Developer details to see the error.'
}

// ── Actors ──────────────────────────────────────────────────────────────────────

const AGENT_NAMES: Record<string, string> = {
  'qualification-agent': 'Fit scoring',
  'routing-agent':       'Routing',
  'first-touch':         'Outreach',
  'human-review':        'Review',
  'escalate-worker':     'Autopilot',
  'resume-play':         'Autopilot',
}

function actorLabel(type: ActorType | string, id: string | null): string {
  switch (type) {
    case 'webhook':        return 'HubSpot'
    case 'agent':          return (id && AGENT_NAMES[id]) || 'Autopilot'
    case 'human':          return 'A teammate'
    case 'system':         return 'Autopilot'
    case 'sla_timer':      return 'Response timer'
    case 'outcome_poller': return 'Salesforce meeting check'
    default:               return 'Autopilot'
  }
}

// ── Action context ──────────────────────────────────────────────────────────────
// action_execution_succeeded/failed rows carry only the idempotency key, so the action
// they belong to is looked up from the earlier action_proposed/started row with that key.

export interface ActionInfo { type: string; params: Record<string, unknown>; reasonCodes: string[] }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function actionFrom(ev: ApiTimelineEvent): ActionInfo | null {
  const pa = obj(ev.proposed_action)
  const type = str(pa.type)
  if (!type) return null
  const params = obj(pa.parameters)
  const reasonCodes = strs(obj(pa.rationale).reasonCodes)
  return { type, params, reasonCodes: reasonCodes.length ? reasonCodes : strs(params.reason_codes) }
}

const ownerName = (p: Obj) => str(p.recommended_owner_name) ?? str(p.owner_name)
const quoted = (s: string | null) => (s ? `“${s}”` : null)

// ── Describe one event ──────────────────────────────────────────────────────────

interface Described { title: string; detail?: string | null; reasons?: string[]; tone: Tone }

function describeAction(ev: ApiTimelineEvent, a: ActionInfo | null): Described {
  const p = a?.params ?? {}
  const reasons = (a?.reasonCodes ?? []).map(reasonText)
  switch (a?.type) {
    case 'qualify_lead': {
      const fit = fitLabel(str(p.icp_tier))
      const score = num(p.icp_score)
      return {
        title: fit ? `Scored as ${fit}` : 'Fit scored',
        detail: score !== null ? `Fit score ${score} out of 100, using your Ideal customer settings.` : null,
        reasons, tone: str(p.icp_tier) === 'not_icp' ? 'warning' : 'success',
      }
    }
    case 'assign_owner': {
      const owner = ownerName(p)
      if (ev.actor_type === 'human') {
        return { title: owner ? `A teammate chose ${owner}` : 'A teammate chose the rep', reasons, tone: 'info' }
      }
      return { title: owner ? `Picked ${owner} as the owner` : 'Picked an owner', reasons, tone: 'info' }
    }
    case 'request_human_review':
      return p.review_kind === 'sequence'
        ? { title: 'Sequence needs sign-off', detail: `Adding this lead to ${quoted(str(p.apollo_sequence_name)) ?? 'the sequence'} needs a person to approve it.`, reasons, tone: 'warning' }
        : { title: 'Needs a person to pick the rep', detail: 'No rep could be chosen automatically.', reasons, tone: 'warning' }
    case 'start_sequence': {
      const plan = str(p.plan)
      if (plan === 'enroll') return { title: `Chose the Apollo sequence ${quoted(str(p.apollo_sequence_name)) ?? ''}`.trim(), reasons, tone: 'info' }
      if (plan === 'manual') return { title: 'No automated outreach', detail: 'The assigned rep follows up by hand within the response time.', reasons, tone: 'info' }
      // The reason chip says why; the failed step that follows carries the fix.
      return { title: 'Outreach is not set up for this lead', reasons, tone: 'warning' }
    }
    case 'mark_nurture':   return { title: 'Decided to move to nurture', reasons, tone: 'warning' }
    case 'mark_duplicate': return { title: 'Decided this is a duplicate', reasons, tone: 'neutral' }
    case 'escalate':       return { title: 'Decided to flag for attention', reasons, tone: 'warning' }
    default:               return { title: 'Decision made', reasons, tone: 'info' }
  }
}

function actionName(a: ActionInfo | null): string {
  switch (a?.type) {
    case 'qualify_lead':         return 'Saving the fit score'
    case 'assign_owner':         return ownerName(a.params) ? `Assigning to ${ownerName(a.params)}` : 'Assigning the owner'
    case 'start_sequence':       return a.params.plan === 'enroll' ? 'Adding to the Apollo sequence' : 'Setting up follow-up'
    case 'mark_nurture':         return 'Moving to nurture'
    case 'mark_duplicate':       return 'Marking as duplicate'
    case 'request_human_review': return 'Sending for review'
    case 'escalate':             return 'Flagging for attention'
    default:                     return 'A step'
  }
}

function describeSucceeded(ev: ApiTimelineEvent, a: ActionInfo | null): Described {
  const p = a?.params ?? {}
  switch (a?.type) {
    case 'qualify_lead': {
      const fit = fitLabel(str(p.icp_tier))
      return { title: fit ? `Saved as ${fit}` : 'Fit score saved', tone: 'success' }
    }
    case 'assign_owner': {
      const owner = ownerName(p) ?? 'the rep'
      return ev.external_system === 'salesforce'
        ? { title: `Assigned to ${owner} in Salesforce`, detail: 'The Lead owner was set and a call Task was created, due at the response deadline.', tone: 'success' }
        : { title: `Assigned to ${owner}`, detail: 'Salesforce is not connected, so nothing was created there.', tone: 'warning' }
    }
    case 'start_sequence':
      return p.plan === 'enroll'
        ? { title: `Added to the Apollo sequence ${quoted(str(p.apollo_sequence_name)) ?? ''}`.trim(), tone: 'success' }
        : { title: 'Left for the rep to contact by hand', tone: 'info' }
    case 'request_human_review':
      return { title: 'Waiting for a person to review', detail: 'It is listed on the Approvals page.', tone: 'warning' }
    case 'mark_nurture':   return { title: 'Moved to nurture', tone: 'warning' }
    case 'mark_duplicate': return { title: 'Marked as duplicate', tone: 'neutral' }
    case 'escalate':       return { title: 'Flagged for attention', tone: 'warning' }
    default:               return { title: 'Step completed', tone: 'success' }
  }
}

function enrichmentSkipped(ev: ApiTimelineEvent): string {
  const snap = obj(ev.decision_snapshot)
  const reason = str(snap.enrichmentSkipReason)
  const msg = ev.error_message ?? ''
  if (reason === 'not_configured') return 'Apollo is not connected, so no company details were looked up.'
  if (reason === 'no_match') return 'Apollo has no record of this company’s website.'
  if (msg.includes('free-email')) return 'The lead used a personal email address, so there is no company to look up.'
  if (msg.includes('invalid email domain')) return 'The email address has no usable company domain.'
  return 'No company details were looked up.'
}

function companySummary(ev: ApiTimelineEvent): string | null {
  const c = obj(obj(ev.decision_snapshot).company)
  const size = num(c.employee_count)
  const parts = [str(c.name), str(c.industry), size !== null ? `${size.toLocaleString('en-US')} employees` : null, str(c.country)]
  const s = parts.filter(Boolean).join(' · ')
  return s || null
}

export function describeEvent(ev: ApiTimelineEvent, action: ActionInfo | null = null): DescribedEvent {
  const d = describeByType(ev, action)
  return {
    id: ev.id,
    at: ev.occurred_at,
    title: d.title,
    detail: d.detail ?? null,
    reasons: d.reasons ?? [],
    tone: d.tone,
    outcome: ev.event_status,
    actor: actorLabel(ev.actor_type, ev.actor_id),
    developer: developerFields(ev, action),
  }
}

function describeByType(ev: ApiTimelineEvent, action: ActionInfo | null): Described {
  const type = ev.event_type as EventType
  switch (type) {
    // Ingestion
    case 'webhook_received':
      // Test leads are sent by an admin from the setup page (actor human), not by HubSpot.
      return ev.actor_type === 'human'
        ? { title: 'Test lead sent from the setup page', detail: 'It runs the real process but never counts in your numbers.', tone: 'info' }
        : { title: 'Form submitted in HubSpot', detail: 'HubSpot sent the form submission to Autopilot.', tone: 'info' }
    case 'idempotency_check_passed':
      return { title: 'New submission', detail: 'This submission had not been seen before.', tone: 'neutral' }
    case 'idempotency_check_failed':
      return { title: 'Repeat submission ignored', detail: 'HubSpot sent this submission more than once. The copy was ignored.', tone: 'neutral' }
    // Enrichment
    case 'enrichment_requested':
      return { title: 'Looking up the company', tone: 'neutral' }
    case 'enrichment_succeeded':
      return { title: 'Company details found', detail: companySummary(ev), tone: 'success' }
    case 'enrichment_failed':
      return { title: 'Company lookup failed', detail: 'Apollo did not answer, so the lead was scored without company details.', tone: 'warning' }
    case 'enrichment_skipped':
      return { title: 'Company lookup skipped', detail: enrichmentSkipped(ev), tone: 'neutral' }
    // Deduplication
    case 'dedup_passed':
      return { title: 'Not a duplicate', detail: 'No other lead in progress uses this email address.', tone: 'success' }
    case 'dedup_rejected':
      return { title: 'Duplicate lead', detail: 'This email address already has a lead in progress, so it was not processed again.', tone: 'warning' }
    case 'reenrollment_allowed': {
      const ctx = obj(obj(ev.decision_snapshot).reenrollmentContext)
      const days = num(ctx.allowAfterDays)
      return {
        title: 'Returning lead accepted',
        detail: days !== null
          ? `Their last play ended more than ${days} days ago, so they start fresh.`
          : 'Their last play ended long enough ago, so they start fresh.',
        tone: 'info',
      }
    }
    // Agent decisions
    case 'action_proposed':
      return describeAction(ev, action)
    case 'action_risk_assessed':
      return { title: 'Safety check run', tone: 'neutral' }
    case 'policy_validated':
      return { title: 'Allowed by your rules', detail: ev.policy_name ? `Rule: ${ev.policy_name}` : null, tone: 'success' }
    case 'policy_rejected':
      return { title: 'Blocked by your rules', detail: ev.policy_name ? `Rule: ${ev.policy_name}` : null, tone: 'danger' }
    // Execution
    case 'action_execution_started':
      return { title: `${actionName(action)}…`, tone: 'neutral' }
    case 'action_execution_succeeded':
      return describeSucceeded(ev, action)
    case 'action_execution_failed':
      return { title: action ? `${actionName(action)} failed` : 'A step failed', detail: errorText(ev.error_code), tone: 'danger' }
    case 'action_execution_deduplicated':
      return { title: 'Already done, not repeated', detail: 'This step had already completed, so it was skipped.', tone: 'neutral' }
    // SLA
    case 'sla_checked':
      return { title: 'Response time checked', tone: 'neutral' }
    case 'sla_breached':
      return { title: 'Response time missed', detail: 'Nobody contacted this lead within the response time.', tone: 'danger' }
    case 'escalation_triggered':
      return { title: 'Flagged for attention', tone: 'warning' }
    case 'escalation_sent': {
      const reason = str(obj(ev.policy_decision).reason)
      return { title: 'Flagged for attention', detail: `${escalationReason(reason)}. It is listed under Needs attention on the Overview.`, tone: 'warning' }
    }
    // AI model (v2)
    case 'model_fallback':
      return { title: 'Rules decided instead of the AI model', detail: modelFallbackText(ev.error_code), tone: 'warning' }
    // Human in the loop
    case 'human_review_requested':
      return { title: 'Sent for review', tone: 'warning' }
    case 'human_approved':
      return { title: 'Approved by a teammate', tone: 'success' }
    case 'human_rejected':
      return { title: 'Rejected by a teammate', tone: 'warning' }
    // Play lifecycle
    case 'play_completed':
      return ev.event_status === 'skipped'
        ? { title: 'Automated steps finished — not contacted yet', detail: 'The lead was not added to a sequence. See Needs attention.', tone: 'warning' }
        : { title: 'All steps finished', tone: 'success' }
    case 'play_failed':
      return { title: 'Stopped after an error', detail: ev.error_code ? errorText(ev.error_code) : null, tone: 'danger' }
    case 'play_paused':
      return { title: 'Paused', tone: 'warning' }
    case 'play_resumed':
      return { title: 'Continued after review', tone: 'info' }
    case 'play_marked_nurture':
      return { title: 'Moved to nurture', detail: 'Sales will not follow up on this lead for now.', tone: 'warning' }
    case 'play_marked_duplicate':
      return { title: 'Marked as duplicate', tone: 'neutral' }
    // Account matching
    case 'account_match_no_match':
      return { title: 'New company', detail: 'No Salesforce account uses this company’s website.', tone: 'neutral' }
    case 'account_match_found':
      return obj(ev.decision_snapshot).matchedOpportunityId
        ? { title: 'Company has an open deal', detail: 'The lead goes to the deal owner in Salesforce.', tone: 'info' }
        : { title: 'Company already in Salesforce', detail: 'The lead goes to the account owner.', tone: 'info' }
    case 'account_match_error':
      return { title: 'Account check skipped', detail: 'Salesforce could not be checked for an existing account, so the lead continued as a new company.', tone: 'warning' }
    // Outcome tracking
    case 'outcome_detected':
      return { title: 'Meeting booked', detail: 'Salesforce shows a meeting with this lead.', tone: 'success' }
    case 'late_meeting_detected':
      return { title: 'Meeting booked after the tracking window', detail: 'It is recorded but does not count toward the meeting rate.', tone: 'info' }
    case 'outcome_window_closed':
      return { title: 'No meeting in the tracking window', tone: 'neutral' }
    default: {
      // Compile-time exhaustiveness; at runtime, a type newer than this dashboard build.
      const unknown: never = type
      return { title: 'Unrecognised step', detail: `This dashboard does not know the step "${String(unknown)}" yet.`, tone: 'neutral' }
    }
  }
}

// ── Developer details ───────────────────────────────────────────────────────────

function developerFields(ev: ApiTimelineEvent, action: ActionInfo | null): DevField[] {
  const snap = obj(ev.decision_snapshot)
  const f: DevField[] = []
  const add = (label: string, value: string | null | undefined) => { if (value) f.push({ label, value }) }

  add('Event type', ev.event_type)
  add('Status', ev.event_status)
  add('Actor', [ev.actor_type, ev.actor_id].filter(Boolean).join(' · '))
  add('Agent', [str(snap.agentName), str(snap.agentVersion) ?? ev.agent_version].filter(Boolean).join(' v'))
  add('Model', [ev.model_name, ev.prompt_version && `prompt ${ev.prompt_version}`].filter(Boolean).join(' · '))
  add('Action', action?.type)
  add('Reason codes', action?.reasonCodes.length ? action.reasonCodes.join(', ') : null)
  if (ev.policy_name) add('Policy check', `${ev.policy_name}: ${ev.policy_passed ? 'passed' : 'blocked'}`)
  add('Error code', ev.error_code)
  add('Error message', ev.error_message)
  if (ev.external_id) add('External record', `${ev.external_system ?? 'external'}: ${ev.external_id}`)
  add('Idempotency key', ev.idempotency_key)
  add('Duration', ev.duration_ms !== null ? `${ev.duration_ms} ms` : null)

  const ref = (v: unknown) => { const o = obj(v); return str(o.id) ? `${o.id} v${num(o.version) ?? '?'}` : null }
  add('Ideal customer policy', ref(snap.icpPolicy))
  add('Outreach policy', ref(snap.outreachPolicy))
  const policies = Array.isArray(snap.policies) ? snap.policies.map(obj) : []
  if (policies.length) add('Policies in snapshot', policies.map(p => `${str(p.rule_type) ?? '?'} “${str(p.name) ?? '?'}” v${num(p.version) ?? '?'}`).join('; '))
  const evidence = strs(snap.evidenceIds)
  if (Array.isArray(snap.evidenceIds)) add('Evidence', evidence.length ? `${evidence.length} item(s): ${evidence.join(', ')}` : 'none')
  add('Workflow run', ev.workflow_run_id)
  add('Event ID', ev.id)
  return f
}

// ── Whole timeline ──────────────────────────────────────────────────────────────

/** Oldest first. Each event is described with the actions proposed before it. */
export function describeTimeline(events: ApiTimelineEvent[]): DescribedEvent[] {
  const sorted = [...events].sort((a, b) => +new Date(a.occurred_at) - +new Date(b.occurred_at))
  const actions = new Map<string, ActionInfo>()
  return sorted.map(ev => {
    const own = actionFrom(ev)
    if (own && ev.idempotency_key) actions.set(ev.idempotency_key, own)
    const action = own ?? (ev.idempotency_key ? actions.get(ev.idempotency_key) ?? null : null)
    return describeEvent(ev, action)
  })
}

/** Facts for the Details card that the lead endpoint does not return directly. */
export interface TimelineFacts {
  owner: string | null
  company: string | null
  sequence: string | null
  failures: number
  lastError: string | null
}

export function timelineFacts(events: ApiTimelineEvent[]): TimelineFacts {
  const sorted = [...events].sort((a, b) => +new Date(a.occurred_at) - +new Date(b.occurred_at))
  const actions = new Map<string, ActionInfo>()
  const facts: TimelineFacts = { owner: null, company: null, sequence: null, failures: 0, lastError: null }
  for (const ev of sorted) {
    const own = actionFrom(ev)
    if (own && ev.idempotency_key) actions.set(ev.idempotency_key, own)
    const company = str(obj(obj(ev.decision_snapshot).company).name)
    if (company) facts.company = company
    if (ev.event_status === 'failed') { facts.failures++; facts.lastError = ev.error_code }
    if (ev.event_type !== 'action_execution_succeeded' || !ev.idempotency_key) continue
    const a = actions.get(ev.idempotency_key)
    if (a?.type === 'assign_owner') facts.owner = ownerName(a.params) ?? facts.owner
    if (a?.type === 'start_sequence' && a.params.plan === 'enroll') facts.sequence = str(a.params.apollo_sequence_name)
  }
  return facts
}

// ── Status summary ──────────────────────────────────────────────────────────────

export interface StatusSummary { headline: string; detail: string; tone: Tone }

const STAGE_NEXT: Record<LeadStage, string> = {
  new:            'The company will be looked up and the lead scored automatically.',
  enriching:      'Looking up company details.',
  routing:        'Choosing the right rep for this lead.',
  in_sequence:    'The lead is in an Apollo sequence. The assigned rep follows up from there.',
  meeting_booked: 'A meeting is booked. No further automated steps.',
  nurture:        'Not followed up by sales right now.',
  lost:           'No further action.',
}

/**
 * One-line answer to "where is this lead now, and does anyone need to act?".
 * Ordered by what most needs a person.
 */
export function summarizeStatus(
  lead: Pick<LeadDetail, 'stage' | 'isDuplicate' | 'icpTier'>,
  play: Pick<PlayState, 'status' | 'sla_breached' | 'first_touch_at' | 'first_touch_deadline' | 'outcome_status'> | null,
  facts: TimelineFacts,
  eventCount: number,
  formatTime: (iso: string) => string,
): StatusSummary {
  const fit = fitLabel(lead.icpTier)
  const owner = facts.owner

  if (!play && eventCount === 0) {
    return { headline: 'Waiting to be processed', detail: 'The form submission was received. Processing usually starts within a minute.', tone: 'neutral' }
  }
  if (play?.outcome_status === 'meeting_booked' || lead.stage === 'meeting_booked') {
    return { headline: 'Meeting booked', detail: owner ? `${owner} has a meeting with this lead.` : 'Salesforce shows a meeting with this lead.', tone: 'success' }
  }
  if (lead.isDuplicate || play?.status === 'duplicate') {
    return { headline: 'Duplicate', detail: 'This email address already had a lead in progress, so it was not processed again.', tone: 'neutral' }
  }
  if (play?.status === 'paused') {
    return { headline: 'Waiting for a person to decide', detail: 'Open Approvals to choose what happens next.', tone: 'warning' }
  }
  if (play?.status === 'failed') {
    return { headline: 'Stopped after an error', detail: errorText(facts.lastError), tone: 'danger' }
  }
  if (play?.sla_breached && !play.first_touch_at) {
    return {
      headline: 'Response time missed',
      detail: owner ? `${owner} has not contacted this lead yet.` : 'Nobody has contacted this lead yet.',
      tone: 'danger',
    }
  }
  if (lead.stage === 'nurture' || play?.status === 'nurture') {
    return { headline: fit ? `In nurture: ${fit}` : 'In nurture', detail: STAGE_NEXT.nurture, tone: 'warning' }
  }
  if (lead.stage === 'in_sequence') {
    return {
      headline: facts.sequence ? `In the Apollo sequence “${facts.sequence}”` : 'In an Apollo sequence',
      detail: owner ? `Owner: ${owner}.` : STAGE_NEXT.in_sequence,
      tone: 'success',
    }
  }
  if (lead.stage === 'lost') return { headline: 'Lost', detail: STAGE_NEXT.lost, tone: 'neutral' }
  if (owner && play && !play.first_touch_at) {
    return {
      headline: `Assigned to ${owner}`,
      detail: play.first_touch_deadline ? `First contact is due ${formatTime(play.first_touch_deadline)}.` : 'Waiting for first contact.',
      tone: 'info',
    }
  }
  if (play?.status === 'completed') return { headline: 'All steps finished', detail: owner ? `Owner: ${owner}.` : STAGE_NEXT[lead.stage], tone: 'success' }
  return { headline: 'In progress', detail: STAGE_NEXT[lead.stage] ?? 'Autopilot is working on this lead.', tone: 'info' }
}
