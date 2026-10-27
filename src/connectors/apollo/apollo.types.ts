/**
 * apollo.types.ts
 * Types for Apollo.io People Enrichment API.
 *
 * Derived from the real Apollo OpenAPI response example at:
 *   https://docs.apollo.io/reference/people-enrichment.md
 *   (retrieved 2026-10-03, response example under "200 → Result")
 *
 * Key structural facts from the real response:
 * - Top-level wrapper: { person: ApolloRawPerson }
 * - match_confidence lives on person, not on a nested match object
 * - match_confidence === 'none' → no match, but HTTP status is STILL 200
 *   This is NOT a 404. The caller must check match_confidence explicitly.
 * - organization is nested under person.organization (not a separate top-level field)
 * - employment_history is an array; current position has current: true
 * - Fields that may be null in practice: twitter_url, github_url, facebook_url,
 *   extrapolated_email_confidence, headline (when no match)
 * - annual_revenue is a number (USD). annual_revenue_printed is a human string ("85M")
 * - estimated_num_employees is a number
 * - industry is a lowercase string ("information technology & services")
 */

// ── Auth / Config ─────────────────────────────────────────────────────────────

export type ApolloConfig = {
  apiKey: string
}

// ── match_confidence ──────────────────────────────────────────────────────────
// Explicitly typed — callers must switch on this value.
//
// From Apollo docs:
//   'high'   → matched with high confidence
//   'medium' → likely match with additional contact data
//   'low'    → partial match assembled from available data
//   'none'   → no match — still returns HTTP 200, person object present but mostly null
//
// 'none' is NOT an error. It means no enrichment data available.
// The caller must return null for the lead (enrichment_skipped), not throw.

export type ApolloMatchConfidence = 'high' | 'medium' | 'low' | 'none'

// ── Employment History ────────────────────────────────────────────────────────

export type ApolloEmploymentHistoryEntry = {
  _id: string
  id:  string
  key: string
  current:           boolean
  title:             string | null
  organization_name: string | null
  organization_id:   string | null
  start_date:        string | null    // "2016-01-01" format
  end_date:          string | null
  // Nullable fields present in the real response
  created_at:  string | null
  updated_at:  string | null
  degree:      string | null
  description: string | null
  emails:      string[] | null
  grade_level: string | null
  kind:        string | null
  major:       string | null
  raw_address: string | null
}

// ── Organization (company data nested under person) ───────────────────────────

export type ApolloOrganization = {
  id:                       string | null
  name:                     string | null
  website_url:              string | null
  linkedin_url:             string | null
  twitter_url:              string | null
  facebook_url:             string | null
  primary_domain:           string | null
  industry:                 string | null
  industries:               string[]
  keywords:                 string[]
  estimated_num_employees:  number | null
  annual_revenue:           number | null        // USD, e.g. 85000000
  annual_revenue_printed:   string | null        // e.g. "85M"
  total_funding:            number | null
  latest_funding_stage:     string | null        // e.g. "Series D"
  founded_year:             number | null
  city:                     string | null
  state:                    string | null
  country:                  string | null
  raw_address:              string | null
  seo_description:          string | null
  short_description:        string | null
  // Many more fields exist in the real response; only typed what we map to evidence
}

// ── Person (main response object) ────────────────────────────────────────────

export type ApolloRawPerson = {
  id:                            string
  first_name:                    string | null
  last_name:                     string | null
  name:                          string | null
  linkedin_url:                  string | null
  title:                         string | null   // current job title
  email:                         string | null
  email_status:                  string | null   // "verified", "likely", etc.
  headline:                      string | null
  photo_url:                     string | null
  twitter_url:                   string | null
  github_url:                    string | null
  facebook_url:                  string | null
  match_confidence:              ApolloMatchConfidence
  organization_id:               string | null
  organization:                  ApolloOrganization | null
  employment_history:            ApolloEmploymentHistoryEntry[]
  state:                         string | null
  city:                          string | null
  country:                       string | null
  // Nullable — only present when reveal_personal_emails=true
  extrapolated_email_confidence: number | null
  revealed_for_current_team:     boolean | null
  contact_id:                    string | null
}

// ── API Response Shape ────────────────────────────────────────────────────────

export type ApolloPeopleMatchResponse = {
  person: ApolloRawPerson | null
}

// ── Enrichment Options ────────────────────────────────────────────────────────

export type ApolloEnrichOptions = {
  revealPersonalEmails?: boolean
  revealPhoneNumber?:    boolean
  runWaterfallEmail?:    boolean
}

// ── Mapped Match Result ───────────────────────────────────────────────────────
// What the connector returns to callers — a structured, typed subset of the
// raw response with only the fields we actually use. The raw response is
// preserved in the evidence row's `data` field for audit purposes.

export type ApolloPersonMatch = {
  apolloId:          string
  email:             string | null
  firstName:         string | null
  lastName:          string | null
  fullName:          string | null
  title:             string | null   // current job title from person.title
  linkedinUrl:       string | null
  location: {
    city:    string | null
    state:   string | null
    country: string | null
  }
  matchConfidence: ApolloMatchConfidence  // always present, never undefined
  company: {
    apolloOrgId:      string | null
    name:             string | null
    domain:           string | null
    industry:         string | null
    employeeCount:    number | null
    annualRevenue:    number | null
    fundingStage:     string | null
    country:          string | null
  } | null
  // Raw response preserved for evidence storage and debugging
  _raw: ApolloRawPerson
}

// ── Organization Enrichment ────────────────────────────────────────────────────
// Source: GET /api/v1/organizations/enrich?domain={domain}
//
// VERIFIED against real Apollo API response for stripe.com (2026-10-05).
// Key structural facts (NOT from docs — from the actual JSON):
//
//  - No-match: HTTP 200, body is {} (empty object — organization key is ABSENT)
//    NOT a 404. Callers must check `!response.organization` explicitly.
//  - Match:    HTTP 200, body is { organization: { ...fields } }
//  - Revenue:  `organization_revenue` (NOT `annual_revenue` — the docs use different names)
//    Both exist in the response and are equal; we use organization_revenue as the canonical one.
//  - Country/city/state: top-level on org (NOT nested under geo like Clearbit)
//  - Industry: `industry` (string, lowercase, e.g. "information technology & services")
//  - Multiple industries: `industries` (string array, first = primary)
//  - Employees: `estimated_num_employees` (integer)
//  - Funding stage: `latest_funding_stage` (string, e.g. "Venture (Round not Specified)")
//  - gmail.com: Apollo returns {} for webmail domains (no organization). Blocklist is still
//    the right gate — it avoids burning API credits and makes the skip reason explicit.

export type ApolloRawOrganization = {
  id:                       string
  name:                     string | null
  website_url:              string | null
  linkedin_url:             string | null
  twitter_url:              string | null
  facebook_url:             string | null
  primary_domain:           string | null
  industry:                 string | null        // primary industry, lowercase
  industries:               string[]             // all industries including primary
  keywords:                 string[]
  estimated_num_employees:  number | null        // VERIFIED: integer (e.g. 9400 for Stripe)
  organization_revenue:     number | null        // VERIFIED: float USD (e.g. 6935000000.0 for Stripe)
  organization_revenue_printed: string | null    // e.g. "6.9B"
  annual_revenue:           number | null        // same value as organization_revenue
  annual_revenue_printed:   string | null
  total_funding:            number | null
  total_funding_printed:    string | null
  latest_funding_stage:     string | null        // e.g. "Venture (Round not Specified)"
  latest_funding_round_date: string | null
  founded_year:             number | null
  city:                     string | null        // top-level, NOT nested under geo
  state:                    string | null        // top-level, e.g. "California"
  country:                  string | null        // top-level, e.g. "United States"
  raw_address:              string | null
  short_description:        string | null
  alexa_ranking:            number | null
  phone:                    string | null
  sic_codes:                string[]
  naics_codes:              string[]
  suborganizations:         Array<{ id: string; name: string; website_url?: string }> | null
  num_suborganizations:     number | null
  owned_by_organization_id: string | null
  departmental_head_count:  Record<string, number> | null
  org_chart_sector:         string | null
  current_technologies:     Array<{ uid: string; name: string; category: string }> | null
  technology_names:         string[]
}

export type ApolloOrganizationEnrichResponse = {
  organization: ApolloRawOrganization | null
}

// ── Mapped result returned by enrichOrganizationByDomain ─────────────────────
// A structured subset. Full raw response is preserved in _raw for evidence audit.

export type ApolloOrganizationMatch = {
  apolloOrgId:   string
  name:          string | null
  domain:        string | null           // primary_domain from response
  industry:      string | null           // primary industry
  industries:    string[]
  employeeCount: number | null           // estimated_num_employees
  revenue:       number | null           // organization_revenue (USD)
  revenuePrinted: string | null          // organization_revenue_printed
  totalFunding:  number | null
  fundingStage:  string | null           // latest_funding_stage
  foundedYear:   number | null
  location: {
    city:    string | null
    state:   string | null
    country: string | null              // "United States", not ISO code
  }
  techStack:     string[]               // technology_names
  _raw:          ApolloRawOrganization
}

// ── Sequences (contacts, sequences, email accounts) ──────────────────────────
// Field names checked against docs.apollo.io (fetched 2026-10-26) and the live
// responses captured by scripts/capture-apollo-sequences.mjs (fixtures in
// __tests__/fixtures/apollo-*.fixture.json). The live account had no sequences
// or mailboxes, so list-item shapes come from the docs examples
// (apollo-*.docs.fixture.json). Only fields we read are typed.

/** One row of contact.contact_campaign_statuses — a contact's membership in a sequence. */
export type ApolloRawContactCampaignStatus = {
  id:                               string
  emailer_campaign_id:              string
  status:                           string           // e.g. "active", "paused", "finished"
  inactive_reason:                  string | null
  send_email_from_email_account_id: string | null
  added_at:                         string | null
}

export type ApolloRawContact = {
  id:                       string
  email:                    string | null
  first_name:               string | null
  last_name:                string | null
  email_status:             string | null            // e.g. "verified", "unverified"
  emailer_campaign_ids:     string[] | null
  contact_campaign_statuses: ApolloRawContactCampaignStatus[] | null
}

/** POST /contacts/search → 200 */
export type ApolloContactsSearchResponse = {
  contacts:   ApolloRawContact[]
  pagination: { page: number; per_page: number; total_entries: number; total_pages: number }
}

/** POST /contacts → 200 */
export type ApolloContactCreateResponse = {
  contact: ApolloRawContact
}

export type ApolloRawSequence = {
  id:       string
  name:     string
  active:   boolean
  archived: boolean
}

/** POST /emailer_campaigns/search → 200 */
export type ApolloSequencesSearchResponse = {
  emailer_campaigns: ApolloRawSequence[]
  pagination: { page: number; per_page: number; total_entries: number; total_pages: number }
}

export type ApolloRawEmailAccount = {
  id:      string
  email:   string
  active:  boolean
  default: boolean
  provider_display_name: string | null
}

/** GET /email_accounts → 200 */
export type ApolloEmailAccountsResponse = {
  email_accounts: ApolloRawEmailAccount[]
}

/** POST /emailer_campaigns/{id}/add_contact_ids → 200 */
export type ApolloAddContactsResponse = {
  contacts:            ApolloRawContact[]
  /** contact id → reason Apollo did not add it, e.g. { "66e3…": "contact_not_found" } */
  skipped_contact_ids: Record<string, string> | null
  emailer_campaign:    { id: string; name: string } | null
}

// ── Mapped results ───────────────────────────────────────────────────────────

export type ApolloContact = {
  id:          string
  email:       string | null
  /** Sequences this contact is already in (emailer_campaign_ids) */
  sequenceIds: string[]
}

export type ApolloSequence = { id: string; name: string; active: boolean }

export type ApolloEmailAccount = { id: string; email: string; active: boolean; isDefault: boolean }

export type ApolloCreateContactInput = {
  email:             string
  firstName?:        string
  lastName?:         string
  title?:            string
  organizationName?: string
  websiteUrl?:       string
}

export type ApolloSequenceEnrollment = {
  contactId:        string
  sequenceId:       string
  /** contact_campaign_statuses[].id for this sequence, when Apollo returns it */
  campaignStatusId: string | null
}
