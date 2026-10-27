/** Plain-language reasons a lead needs a person, and why it was flagged. */

const REVIEW_REASONS: Record<string, string> = {
  NO_TERRITORY_MATCH:     'No territory covers this lead’s country',
  NO_REPS_IN_TERRITORY:   'The matching territory has no reps',
  ALL_REPS_UNAVAILABLE:   'Every rep in the territory is away',
  ALL_REPS_AT_CAPACITY:   'Every rep in the territory is at their lead limit',
  OWNER_LIST_EMPTY:       'No reps have been imported yet',
  OUTREACH_ENROLL:        'Adding this lead to a sequence needs sign-off',
  MODEL_RULES_DISAGREE:   'The AI model and your rules disagree on whether this lead fits. Assign a rep if it does, or reject.',
}

const ESCALATION_REASONS: Record<string, string> = {
  SLA_BREACHED:                   'Missed the response time',
  NO_SEP_CONNECTOR_AVAILABLE:     'Apollo is not connected, so no sequence was started',
  OUTREACH_POLICY_MISSING:        'Outreach is not set up',
  OUTREACH_POLICY_INVALID:        'Outreach settings need to be picked again',
  OUTREACH_TIER_NOT_SET:          'No sequence chosen for this fit level',
  OUTREACH_EMAIL_ACCOUNT_NOT_SET: 'No sending mailbox chosen',
  OUTREACH_TIER_UNKNOWN:          'The lead has no fit level to pick a sequence',
  AP_SEQUENCE_FAILED:             'Apollo did not add the lead to the sequence',
  AP_CONTACT_FAILED:              'Apollo could not create the contact',
  AP_INSUFFICIENT_SCOPE:          'The Apollo key is missing a permission',
  AP_AUTH_FAILED:                 'Apollo did not accept the API key',
  LEAD_EMAIL_MISSING:             'The lead has no email address',
}

export const reviewReason = (code: string) => REVIEW_REASONS[code] ?? 'Needs a person to decide'
export const escalationReason = (code: string | null) =>
  code ? ESCALATION_REASONS[code] ?? 'Needs a person to follow up' : 'Needs a person to follow up'

/** "5 min", "3 h", "2 days" — how long ago. */
export function since(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} days`
}
