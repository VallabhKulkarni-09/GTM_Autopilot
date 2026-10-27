/**
 * hubspot.errors.ts
 * Error codes for the HubSpot connector.
 */

export const HubSpotErrorCode = {
  // Auth
  AUTH_FAILED:                  'HS_AUTH_FAILED',

  // Contact operations
  CONTACT_NOT_FOUND:            'HS_CONTACT_NOT_FOUND',
  CONTACT_SEARCH_FAILED:        'HS_CONTACT_SEARCH_FAILED',
  CONTACT_UPDATE_FAILED:        'HS_CONTACT_UPDATE_FAILED',
  LIFECYCLE_STAGE_UPDATE_FAILED:'HS_LIFECYCLE_STAGE_UPDATE_FAILED',

  // Webhook
  INVALID_SIGNATURE:            'HS_INVALID_SIGNATURE',

  // Health check
  HEALTH_CHECK_FAILED:          'HS_HEALTH_CHECK_FAILED',
  ACCOUNT_INFO_FAILED:          'HS_ACCOUNT_INFO_FAILED',

  // Generic
  REQUEST_FAILED:               'HS_REQUEST_FAILED',
  UNKNOWN_ERROR:                'HS_UNKNOWN_ERROR',
} as const

export type HubSpotErrorCode = typeof HubSpotErrorCode[keyof typeof HubSpotErrorCode]
