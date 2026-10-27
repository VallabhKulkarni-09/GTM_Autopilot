/**
 * zoominfo.types.ts
 * Types for the ZoomInfo enrichment API connector.
 *
 * Auth: JWT-based (NOT OAuth2). Two supported modes:
 *   1. username + password → POST /authenticate → jwt (60 min TTL, no refresh token)
 *   2. clientId + privateKey → sign JWT locally (production-recommended)
 *
 * For MVP: username + password exchange.
 *
 * ZoomInfo roles in GTM Autopilot:
 *   - Enrichment: supplements or replaces Clearbit
 *   - Evidence stored as source_type='zoominfo_enrichment' in the evidence table
 *   - Additive to Clearbit (both can run, qualification agent uses confidence scores)
 *
 * Env vars (read by connector factory):
 *   ZOOMINFO_USERNAME
 *   ZOOMINFO_PASSWORD
 */

// ─── Config ───────────────────────────────────────────────────────────────────

export type ZoomInfoConfig = {
  username: string   // ZOOMINFO_USERNAME
  password: string   // ZOOMINFO_PASSWORD
}

// ─── Auth Response ────────────────────────────────────────────────────────────

export type ZoomInfoAuthResponse = {
  jwt:           string
  email:         string
  firstName:     string
  lastName:      string
  // ZoomInfo returns additional profile fields
}

// ─── Enrichment Entities ──────────────────────────────────────────────────────

export type ZoomInfoPerson = {
  id?:            number
  firstName?:     string
  lastName?:      string
  email?:         string
  directPhone?:   string
  jobTitle?:      string
  jobFunction?:   string
  seniorityLevel?: string
  managementLevel?: string
  companyId?:     number
  companyName?:   string
  companyWebsite?: string
  companyRevenue?: number
  companyEmployeeCount?: number
  companyIndustry?: string
  city?:          string
  state?:         string
  country?:       string
}

export type ZoomInfoCompany = {
  id?:              number
  name?:            string
  website?:         string
  ticker?:          string
  revenue?:         number
  revenueRange?:    string
  employeeCount?:   number
  industry?:        string
  subIndustry?:     string
  sicCode?:         string
  naicsCode?:       string
  city?:            string
  state?:           string
  country?:         string
  zipCode?:         string
  phone?:           string
  founded?:         number
  description?:     string
}

// ─── Search Request/Response Shapes ──────────────────────────────────────────

export type ZoomInfoContactSearchRequest = {
  outputFields: string[]
  matchPersonInput: Array<{
    emailAddress?: string
    firstName?:    string
    lastName?:     string
    companyName?:  string
  }>
}

export type ZoomInfoCompanySearchRequest = {
  outputFields:   string[]
  companyInput:   Array<{
    websiteURL?:  string
    companyName?: string
  }>
}

export type ZoomInfoSearchResponse<T> = {
  data: {
    outputFields: string[]
    result:       Array<{
      matchStatus:      string
      input:            Record<string, string>
      data?:            T[]
    }>
  }
  error?: string
}
