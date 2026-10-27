/**
 * zoominfo.errors.ts
 * Error codes for the ZoomInfo connector.
 * Prefix ZI_ distinguishes these from other connector error codes.
 */

export const ZoomInfoErrorCode = {
  // Auth (JWT-based — not OAuth2)
  AUTH_FAILED:              'ZI_AUTH_FAILED',
  TOKEN_EXPIRED:            'ZI_TOKEN_EXPIRED',

  // Enrichment operations
  PERSON_ENRICH_FAILED:     'ZI_PERSON_ENRICH_FAILED',
  COMPANY_ENRICH_FAILED:    'ZI_COMPANY_ENRICH_FAILED',

  // Generic
  HEALTH_CHECK_FAILED:      'ZI_HEALTH_CHECK_FAILED',
  REQUEST_FAILED:           'ZI_REQUEST_FAILED',
  UNKNOWN_ERROR:            'ZI_UNKNOWN_ERROR',
} as const

export type ZoomInfoErrorCode = typeof ZoomInfoErrorCode[keyof typeof ZoomInfoErrorCode]
