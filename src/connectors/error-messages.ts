/**
 * error-messages.ts — plain-language explanation + next step for every v1 connector error code.
 * Shown to non-technical users on the Connections page. Every code a v1 connector can throw
 * must appear here (enforced by tests/unit/connectors/error-messages.test.ts).
 */

export type FriendlyError = { title: string; fix: string }

export const CONNECTOR_ERROR_MESSAGES: Record<string, FriendlyError> = {
  // ── HubSpot ────────────────────────────────────────────────────────────────
  HS_AUTH_FAILED: { title: 'HubSpot did not accept the access token.', fix: 'In HubSpot → Settings → Integrations → Private Apps, open your app, copy the access token again and paste it here.' },
  HS_ACCOUNT_INFO_FAILED: { title: 'HubSpot did not return your account details.', fix: 'Make sure the private app has the "crm.objects.contacts.read" scope, then try again.' },
  HS_CONTACT_NOT_FOUND: { title: 'HubSpot could not find that contact.', fix: 'The contact may have been deleted. No action needed.' },
  HS_CONTACT_SEARCH_FAILED: { title: 'Could not read contacts from HubSpot.', fix: 'Make sure the private app has the "crm.objects.contacts.read" scope.' },
  HS_CONTACT_UPDATE_FAILED: { title: 'Could not update the contact in HubSpot.', fix: 'Make sure the private app has the "crm.objects.contacts.write" scope.' },
  HS_LIFECYCLE_STAGE_UPDATE_FAILED: { title: 'Could not update the lifecycle stage in HubSpot.', fix: 'Make sure the private app has the "crm.objects.contacts.write" scope.' },
  HS_INVALID_SIGNATURE: { title: 'A webhook from HubSpot could not be verified.', fix: 'Paste the app\'s Client secret (not the access token) into "App client secret".' },
  HS_HEALTH_CHECK_FAILED: { title: 'HubSpot is not responding.', fix: 'Try again in a few minutes.' },
  HS_REQUEST_FAILED: { title: 'Could not reach HubSpot.', fix: 'Check this server\'s internet connection and try again.' },
  HS_UNKNOWN_ERROR: { title: 'HubSpot returned an unexpected error.', fix: 'Try again. If it keeps happening, check HubSpot\'s status page.' },

  // ── Salesforce ─────────────────────────────────────────────────────────────
  SF_AUTH_FAILED: { title: 'Salesforce did not accept these details.', fix: 'Check the Consumer key and secret, and that "Enable Client Credentials Flow" is on with a "Run As" user in the Connected App.' },
  SF_QUERY_FAILED: { title: 'Connected, but could not read data from Salesforce.', fix: 'Give the Connected App\'s "Run As" user permission to read Users, Leads and Events.' },
  SF_TOKEN_REFRESH_FAILED: { title: 'Salesforce did not issue an access token.', fix: 'Check the Salesforce URL, Consumer key and secret, and that "Enable Client Credentials Flow" is on with a "Run As" user.' },
  SF_HEALTH_CHECK_FAILED: { title: 'Salesforce is not responding.', fix: 'Try again in a few minutes.' },
  SF_REQUEST_FAILED: { title: 'Could not reach Salesforce.', fix: 'Check the Salesforce URL (it looks like https://yourcompany.my.salesforce.com).' },
  SF_UNKNOWN_ERROR: { title: 'Salesforce returned an unexpected error.', fix: 'Try again. If it keeps happening, check Salesforce\'s status page.' },
  SF_USER_QUERY_FAILED: { title: 'Could not read your sales reps from Salesforce.', fix: 'Give the "Run As" user permission to view Users.' },
  SF_LEAD_QUERY_FAILED: { title: 'Could not read Leads from Salesforce.', fix: 'Give the "Run As" user Read access on Leads.' },
  SF_LEAD_NOT_FOUND: { title: 'The Lead was not found in Salesforce.', fix: 'It may have been deleted or converted. No action needed.' },
  SF_LEAD_CREATE_FAILED: { title: 'Could not create the Lead in Salesforce.', fix: 'Give the "Run As" user Create access on Leads, and check required custom fields on Lead.' },
  SF_LEAD_UPDATE_FAILED: { title: 'Could not update the Lead in Salesforce.', fix: 'Give the "Run As" user Edit access on Leads.' },
  SF_LEAD_ASSIGN_FAILED: { title: 'Could not set the Lead owner in Salesforce.', fix: 'Give the "Run As" user permission to transfer Leads, and make sure the rep is an active user.' },
  SF_TASK_CREATE_FAILED: { title: 'Could not create the follow-up Task in Salesforce.', fix: 'Give the "Run As" user Create access on Tasks.' },
  SF_EVENT_QUERY_FAILED: { title: 'Could not read meetings from Salesforce.', fix: 'Give the "Run As" user Read access on Events (calendar).' },
  SF_EVENT_OBJECT_NOT_ACCESSIBLE: { title: 'Meetings (Events) are not visible to the connected user.', fix: 'Give the "Run As" user Read access on Events so booked meetings can be detected.' },
  SF_LEAD_STATUS_QUERY_FAILED: { title: 'Could not read Lead status from Salesforce.', fix: 'Give the "Run As" user Read access on Leads.' },
  SF_OPPORTUNITY_STAGE_QUERY_FAILED: { title: 'Could not read Opportunities from Salesforce.', fix: 'Give the "Run As" user Read access on Opportunities.' },
  SF_CUSTOM_FIELD_QUERY_FAILED: { title: 'Could not read a custom field from Salesforce.', fix: 'Check the field name in Meeting detection settings exists and is visible to the "Run As" user.' },

  // ── Apollo ─────────────────────────────────────────────────────────────────
  AP_AUTH_FAILED: { title: 'Apollo did not accept the API key.', fix: 'In Apollo → Settings → Integrations → API, create a key and paste it here.' },
  AP_INSUFFICIENT_SCOPE: { title: 'This Apollo key is missing a permission.', fix: 'Create a master API key in Apollo → Settings → Integrations → API, or a key that includes Organization enrichment and Sequences.' },
  AP_RATE_LIMITED: { title: 'Apollo says too many requests were made.', fix: 'Wait a minute and try again. Your Apollo plan sets this limit.' },
  AP_ENRICH_FAILED: { title: 'Apollo could not look up the company.', fix: 'Try again. If it keeps happening, check your Apollo plan includes Organization enrichment.' },
  AP_CONTACT_FAILED: { title: 'Could not find or create the contact in Apollo.', fix: 'Make sure your Apollo key can search and create contacts (a master API key can), then try again.' },
  AP_SEQUENCE_FAILED: { title: 'Apollo did not add the contact to the sequence.', fix: 'Check the sequence is active and the sending mailbox is connected in Apollo, then pick them again on the Outreach page.' },
  AP_NOT_CONNECTED: { title: 'Apollo is not connected.', fix: 'Add your Apollo API key on this page.' },
  AP_NETWORK_ERROR: { title: 'Could not reach Apollo.', fix: 'Check this server\'s internet connection and try again.' },

  // ── Generic ────────────────────────────────────────────────────────────────
  TIMEOUT: { title: 'The service took too long to answer.', fix: 'Try again in a moment.' },
  CONNECTION_FAILED: { title: 'Could not connect.', fix: 'Check the details and try again.' },
  MISSING_FIELDS: { title: 'Some details are missing.', fix: 'Fill in every field marked as required.' },
  PORTAL_IN_USE: { title: 'This HubSpot account is already connected to another workspace.', fix: 'Each HubSpot account can belong to one workspace. Disconnect it there first.' },
}

export function friendlyError(code: string | undefined): FriendlyError {
  return (code && CONNECTOR_ERROR_MESSAGES[code]) || CONNECTOR_ERROR_MESSAGES.CONNECTION_FAILED
}
