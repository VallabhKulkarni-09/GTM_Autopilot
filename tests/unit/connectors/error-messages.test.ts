import { describe, it, expect } from 'vitest'
import { HubSpotErrorCode } from '../../../src/connectors/hubspot/hubspot.errors.js'
import { SalesforceErrorCode } from '../../../src/connectors/salesforce/salesforce.errors.js'
import { ApolloErrorCode } from '../../../src/connectors/apollo/apollo.errors.js'
import { CONNECTOR_ERROR_MESSAGES, friendlyError } from '../../../src/connectors/error-messages.js'

describe('connector error messages', () => {
  const codes = [
    ...Object.values(HubSpotErrorCode),
    ...Object.values(SalesforceErrorCode),
    ...Object.values(ApolloErrorCode),
    'TIMEOUT',
  ]

  it.each(codes)('%s has a plain-language title and a next step', code => {
    const m = CONNECTOR_ERROR_MESSAGES[code]
    expect(m, `missing message for ${code}`).toBeDefined()
    expect(m.title.length).toBeGreaterThan(10)
    expect(m.fix.length).toBeGreaterThan(10)
  })

  it('falls back to a generic message for unknown codes', () => {
    expect(friendlyError('SOMETHING_NEW').title).toBe('Could not connect.')
    expect(friendlyError(undefined).title).toBe('Could not connect.')
  })
})
