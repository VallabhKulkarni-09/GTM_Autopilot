/**
 * action-registry.ts
 * Human-readable labels for all ActionTypes.
 * Used by the dashboard to render event timelines in plain English.
 */

export const ACTION_TYPE_LABELS: Record<string, string> = {
  qualify_lead:          'Lead qualification',
  assign_owner:          'Owner assignment',
  start_sequence:        'Sequence enrollment',
  mark_nurture:          'Moved to nurture',
  mark_duplicate:        'Marked as duplicate',
  request_human_review:  'Human review requested',
  escalate:              'Escalation triggered',
}

export type ActionType = keyof typeof ACTION_TYPE_LABELS
