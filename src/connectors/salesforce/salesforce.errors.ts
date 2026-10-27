/**
 * salesforce.errors.ts
 * Error codes for the Salesforce connector.
 * All codes are SCREAMING_SNAKE_CASE and map to specific failure scenarios.
 */

export const SalesforceErrorCode = {
  // Authentication
  AUTH_FAILED:              'SF_AUTH_FAILED',
  TOKEN_REFRESH_FAILED:     'SF_TOKEN_REFRESH_FAILED',

  // Lead operations
  LEAD_NOT_FOUND:           'SF_LEAD_NOT_FOUND',
  LEAD_CREATE_FAILED:       'SF_LEAD_CREATE_FAILED',
  LEAD_UPDATE_FAILED:       'SF_LEAD_UPDATE_FAILED',
  LEAD_ASSIGN_FAILED:       'SF_LEAD_ASSIGN_FAILED',
  LEAD_QUERY_FAILED:        'SF_LEAD_QUERY_FAILED',

  // Task operations
  TASK_CREATE_FAILED:       'SF_TASK_CREATE_FAILED',

  // User operations
  USER_QUERY_FAILED:        'SF_USER_QUERY_FAILED',

  // Event / outcome tracking operations
  EVENT_QUERY_FAILED:              'SF_EVENT_QUERY_FAILED',
  EVENT_OBJECT_NOT_ACCESSIBLE:     'SF_EVENT_OBJECT_NOT_ACCESSIBLE',  // OAuth scope missing
  LEAD_STATUS_QUERY_FAILED:        'SF_LEAD_STATUS_QUERY_FAILED',
  OPPORTUNITY_STAGE_QUERY_FAILED:  'SF_OPPORTUNITY_STAGE_QUERY_FAILED',
  CUSTOM_FIELD_QUERY_FAILED:       'SF_CUSTOM_FIELD_QUERY_FAILED',

  // Health check
  HEALTH_CHECK_FAILED:      'SF_HEALTH_CHECK_FAILED',

  // Generic
  REQUEST_FAILED:           'SF_REQUEST_FAILED',
  UNKNOWN_ERROR:            'SF_UNKNOWN_ERROR',
} as const

export type SalesforceErrorCode = typeof SalesforceErrorCode[keyof typeof SalesforceErrorCode]
