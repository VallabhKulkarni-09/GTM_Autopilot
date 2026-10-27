/**
 * clearbit.errors.ts
 * Error codes for the Clearbit connector.
 */

export const ClearbitErrorCode = {
  // Auth
  AUTH_FAILED:              'CB_AUTH_FAILED',

  // Enrichment operations
  ENRICH_EMAIL_FAILED:      'CB_ENRICH_EMAIL_FAILED',
  ENRICH_DOMAIN_FAILED:     'CB_ENRICH_DOMAIN_FAILED',

  // Health check
  HEALTH_CHECK_FAILED:      'CB_HEALTH_CHECK_FAILED',

  // Generic
  REQUEST_FAILED:           'CB_REQUEST_FAILED',
  UNKNOWN_ERROR:            'CB_UNKNOWN_ERROR',
} as const

export type ClearbitErrorCode = typeof ClearbitErrorCode[keyof typeof ClearbitErrorCode]
