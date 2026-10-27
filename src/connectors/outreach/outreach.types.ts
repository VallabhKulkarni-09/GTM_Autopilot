/**
 * outreach.types.ts
 * Outreach-specific types for the GTM Autopilot connector.
 *
 * Auth model: Outreach uses OAuth2 authorization_code flow.
 * No static API keys exist. Access tokens expire ~2 hours;
 * refresh tokens are long-lived and used to obtain new access tokens.
 */

// ─── Outreach Config ──────────────────────────────────────────────────────────

export type OutreachConfig = {
  clientId:     string   // OUTREACH_CLIENT_ID
  clientSecret: string   // OUTREACH_CLIENT_SECRET
  accessToken:  string   // OUTREACH_ACCESS_TOKEN (expires ~2h)
  refreshToken: string   // OUTREACH_REFRESH_TOKEN (long-lived)
  /**
   * mailboxId is REQUIRED for sequenceState creation.
   * Every email sent through a sequence must be sent from a specific mailbox.
   * Get this from Outreach Settings → Mailboxes → ID in the URL.
   * Stored as OUTREACH_MAILBOX_ID.
   */
  mailboxId:    string
}

// ─── OAuth Token Response ─────────────────────────────────────────────────────

export type OutreachTokenResponse = {
  access_token:  string
  refresh_token: string
  token_type:    string
  expires_in:    number
  scope:         string
  created_at:    number
}

// ─── Outreach Entities ────────────────────────────────────────────────────────

export type OutreachProspect = {
  id: string
  type: 'prospect'
  attributes: {
    emails: string[]
    firstName: string | null
    lastName: string | null
    title: string | null
    phoneNumbers: string[]
    createdAt: string
    updatedAt: string
  }
  relationships: {
    owner?: { data: { id: string; type: 'user' } | null }
  }
}

export type OutreachSequence = {
  id: string
  type: 'sequence'
  attributes: {
    name: string
    enabled: boolean
    currentState: string
    daysInState: number
  }
}

export type OutreachSequenceState = {
  id: string
  type: 'sequenceState'
  attributes: {
    state: string
    createdAt: string
    updatedAt: string
  }
  relationships: {
    prospect: { data: { id: string; type: 'prospect' } }
    sequence: { data: { id: string; type: 'sequence' } }
    mailbox:  { data: { id: string; type: 'mailbox' } }
  }
}

export type OutreachTask = {
  id: string
  type: 'task'
  attributes: {
    subject: string
    dueAt: string | null
    completedAt: string | null
    state: string
    taskType: string
    createdAt: string
  }
}

// ─── Input Types ──────────────────────────────────────────────────────────────

export type CreateProspectInput = {
  email: string
  firstName?: string
  lastName?: string
  title?: string
  phone?: string
  ownerId?: string
}

export type CreateTaskInput = {
  subject: string
  taskType?: string
  dueAt?: string   // ISO 8601
}

// ─── Outreach API Response Types ──────────────────────────────────────────────

export type OutreachApiResponse<T> = {
  data: T
  meta?: Record<string, unknown>
}

export type OutreachApiListResponse<T> = {
  data: T[]
  meta?: { count: number; nextPageLink?: string }
}

export type OutreachErrorResponse = {
  errors: Array<{
    id: string
    title: string
    detail: string
    status: string
  }>
}
