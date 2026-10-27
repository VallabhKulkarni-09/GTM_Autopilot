/**
 * salesloft.errors.ts
 * Error codes for the Salesloft connector.
 * Prefix SL_ distinguishes these from Outreach (OR_) and Salesforce (SF_) codes.
 */

export const SalesloftErrorCode = {
  // Auth
  AUTH_FAILED:              'SL_AUTH_FAILED',

  // Person operations (Salesloft calls them "People", not "Prospects")
  PERSON_NOT_FOUND:         'SL_PERSON_NOT_FOUND',
  PERSON_SEARCH_FAILED:     'SL_PERSON_SEARCH_FAILED',
  PERSON_CREATE_FAILED:     'SL_PERSON_CREATE_FAILED',

  // Cadence operations (Salesloft calls them "Cadences", not "Sequences")
  CADENCE_ENROLL_FAILED:    'SL_CADENCE_ENROLL_FAILED',
  CADENCE_LIST_FAILED:      'SL_CADENCE_LIST_FAILED',

  // Task operations
  TASK_CREATE_FAILED:       'SL_TASK_CREATE_FAILED',

  // Generic
  HEALTH_CHECK_FAILED:      'SL_HEALTH_CHECK_FAILED',
  REQUEST_FAILED:           'SL_REQUEST_FAILED',
  UNKNOWN_ERROR:            'SL_UNKNOWN_ERROR',
} as const

export type SalesloftErrorCode = typeof SalesloftErrorCode[keyof typeof SalesloftErrorCode]
