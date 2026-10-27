/**
 * outreach.errors.ts
 * Error codes for the Outreach connector.
 */

export const OutreachErrorCode = {
  // Auth
  AUTH_FAILED:                'OR_AUTH_FAILED',

  // Prospect operations
  PROSPECT_NOT_FOUND:         'OR_PROSPECT_NOT_FOUND',
  PROSPECT_SEARCH_FAILED:     'OR_PROSPECT_SEARCH_FAILED',
  PROSPECT_CREATE_FAILED:     'OR_PROSPECT_CREATE_FAILED',

  // Sequence operations
  SEQUENCE_ENROLL_FAILED:     'OR_SEQUENCE_ENROLL_FAILED',
  SEQUENCE_LIST_FAILED:       'OR_SEQUENCE_LIST_FAILED',

  // Task operations
  TASK_CREATE_FAILED:         'OR_TASK_CREATE_FAILED',

  // Health check
  HEALTH_CHECK_FAILED:        'OR_HEALTH_CHECK_FAILED',

  // Generic
  REQUEST_FAILED:             'OR_REQUEST_FAILED',
  UNKNOWN_ERROR:              'OR_UNKNOWN_ERROR',
} as const

export type OutreachErrorCode = typeof OutreachErrorCode[keyof typeof OutreachErrorCode]
