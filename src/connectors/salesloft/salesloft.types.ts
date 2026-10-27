/**
 * salesloft.types.ts
 * Types for the Salesloft API v2 connector.
 *
 * IMPORTANT TERMINOLOGY (verified against Salesloft API docs):
 *   - "People" — what Outreach calls "Prospects". Endpoint: /v2/people
 *   - "Cadences" — what Outreach calls "Sequences". Endpoint: /v2/cadences
 *   - "Cadence Memberships" — enrolling a Person in a Cadence. Endpoint: /v2/cadence_memberships
 *
 * Auth: OAuth2 authorization_code flow
 *   Authorize URL: https://accounts.salesloft.com/oauth/authorize
 *   Token URL:     https://accounts.salesloft.com/oauth/token
 *   Scopes:        cadences.r cadences.w people.r people.w
 *
 * Env vars (read by connector factory):
 *   SALESLOFT_CLIENT_ID
 *   SALESLOFT_CLIENT_SECRET
 *   SALESLOFT_ACCESS_TOKEN
 *   SALESLOFT_REFRESH_TOKEN
 *   SALESLOFT_REDIRECT_URI
 */

// ─── Config ───────────────────────────────────────────────────────────────────

export type SalesloftConfig = {
  clientId:     string   // SALESLOFT_CLIENT_ID
  clientSecret: string   // SALESLOFT_CLIENT_SECRET
  accessToken:  string   // SALESLOFT_ACCESS_TOKEN (short-lived)
  refreshToken: string   // SALESLOFT_REFRESH_TOKEN (long-lived, rotates on use)
}

// ─── OAuth Token Response ─────────────────────────────────────────────────────

export type SalesloftTokenResponse = {
  access_token:  string
  refresh_token: string
  token_type:    string
  expires_in:    number
  scope:         string
  created_at:    number
}

// ─── Entities ─────────────────────────────────────────────────────────────────

export type SalesloftPerson = {
  id:            number
  email_address: string
  first_name:    string | null
  last_name:     string | null
  title:         string | null
  phone:         string | null
  created_at:    string
  updated_at:    string
}

export type SalesloftCadence = {
  id:            number
  name:          string
  archived:      boolean
  current_state: string   // 'active' | 'draft' | 'archived'
  team_cadence:  boolean
  created_at:    string
  updated_at:    string
}

export type SalesloftCadenceMembership = {
  id:             number
  added_at:       string
  current_state:  string   // 'active' | 'paused' | 'completed' | 'removed'
  person: {
    id:    number
    _href: string
  }
  cadence: {
    id:    number
    _href: string
  }
  user: {
    id:    number
    _href: string
  }
}

// ─── Input Types ──────────────────────────────────────────────────────────────

export type CreatePersonInput = {
  email_address: string
  first_name?:   string
  last_name?:    string
  title?:        string
  phone?:        string
  owner_id?:     number
}

// ─── API Response Wrappers ────────────────────────────────────────────────────

export type SalesloftApiResponse<T> = {
  data:     T
  metadata: {
    paging?: {
      per_page:   number
      current_page: number
      next_page:  number | null
      prev_page:  number | null
    }
    filtering?: Record<string, unknown>
    sorting?:   Record<string, unknown>
  }
}

export type SalesloftApiListResponse<T> = {
  data:     T[]
  metadata: {
    paging: {
      per_page:     number
      current_page: number
      next_page:    number | null
      prev_page:    number | null
    }
  }
}

export type SalesloftErrorResponse = {
  errors?: Record<string, string[]>
  error?:  string
}
