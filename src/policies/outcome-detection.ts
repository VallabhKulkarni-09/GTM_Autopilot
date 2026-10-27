/**
 * outcome-detection.ts
 * Typed config loader for the 'outcome_detection' policy rule type.
 *
 * IMPORTANT: loadOutcomeDetectionConfig() throws OutcomeDetectionConfigMissingError
 * if no active 'outcome_detection' rule exists for the org.
 * This is intentional — callers must handle the error explicitly.
 * NEVER silently fall back to hardcoded defaults in production.
 * The meeting type strings, attribution window, and SF field names
 * are org-specific configuration — there is no universal safe default.
 */

import { getDb } from '../db/client.js'

// ── Config shape ─────────────────────────────────────────────────────────────
// Mirrors the 'conditions' JSONB column on policy_rules for rule_type='outcome_detection'.

export interface OutcomeDetectionConfig {
  /** Salesforce Event.Type values that count as a meeting (primary signal). */
  primaryMeetingTypes: string[]
  /** Number of days after play start to look for meetings. Captured at play creation. */
  attributionWindowDays: number
  /** Salesforce Lead.Status values that indicate a meeting (supportive only). */
  supportiveLeadStatuses: string[]
  /** SF custom checkbox field API name (e.g. 'Meeting_Booked__c'). Null = not configured. */
  supportiveCheckboxField: string | null
  /** Substrings to match against Opportunity StageName (supportive only). */
  supportiveOpportunityStageKeywords: string[]
}

// ── Typed error ───────────────────────────────────────────────────────────────

export class OutcomeDetectionConfigMissingError extends Error {
  constructor(organizationId: string) {
    super(
      `[outcome-detection] No active 'outcome_detection' policy rule found for org ${organizationId}. ` +
      `Seed a policy_rules row with rule_type='outcome_detection' and the config in 'conditions' JSONB. ` +
      `Expected shape: { primary_meeting_types, attribution_window_days, supportive_lead_statuses, ` +
      `supportive_checkbox_field, supportive_opportunity_stage_keywords }.`
    )
    this.name = 'OutcomeDetectionConfigMissingError'
  }
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Loads and validates the outcome detection config for an org.
 *
 * @throws {OutcomeDetectionConfigMissingError} if no active 'outcome_detection' rule exists.
 * NEVER falls back to guessed defaults — callers must handle the error.
 *
 * Config is read from policy_rules.conditions JSONB:
 * {
 *   "primary_meeting_types": ["Meeting", "Discovery Call"],
 *   "attribution_window_days": 14,
 *   "supportive_lead_statuses": ["Meeting Booked"],
 *   "supportive_checkbox_field": "Meeting_Booked__c",
 *   "supportive_opportunity_stage_keywords": ["Discovery"]
 * }
 */
export async function loadOutcomeDetectionConfig(
  organizationId: string
): Promise<OutcomeDetectionConfig> {
  const { data, error } = await getDb()
    .from('policy_rules')
    .select('conditions')
    .eq('organization_id', organizationId)
    .eq('rule_type', 'outcome_detection')
    .eq('is_active', true)
    .order('priority', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) {
    throw new OutcomeDetectionConfigMissingError(organizationId)
  }

  const c = data.conditions as Record<string, unknown>

  return {
    primaryMeetingTypes:                  (c['primary_meeting_types'] as string[])                  ?? [],
    attributionWindowDays:                (c['attribution_window_days'] as number)                 ?? 14,
    supportiveLeadStatuses:               (c['supportive_lead_statuses'] as string[])               ?? [],
    supportiveCheckboxField:              (c['supportive_checkbox_field'] as string | null)          ?? null,
    supportiveOpportunityStageKeywords:   (c['supportive_opportunity_stage_keywords'] as string[]) ?? [],
  }
}
