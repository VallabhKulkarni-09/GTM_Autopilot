/**
 * clearbit.types.ts
 * Clearbit-specific types for the GTM Autopilot connector.
 */

// ─── Clearbit Config ──────────────────────────────────────────────────────────

export type ClearbitConfig = {
  apiKey: string  // CLEARBIT_API_KEY
}

// ─── Clearbit Entities ────────────────────────────────────────────────────────

export type ClearbitPerson = {
  id: string
  name: { fullName: string | null; givenName: string | null; familyName: string | null }
  email: string
  location: string | null
  timeZone: string | null
  utcOffset: number | null
  geo: {
    city: string | null
    state: string | null
    country: string | null
    lat: number | null
    lng: number | null
  }
  bio: string | null
  site: string | null
  avatar: string | null
  employment: {
    domain: string | null
    name: string | null
    title: string | null
    role: string | null
    seniority: string | null
    subRole: string | null
  }
  linkedin: { handle: string | null }
  twitter: { handle: string | null }
  github: { handle: string | null }
  company: ClearbitCompany | null
}

export type ClearbitCompany = {
  id: string
  name: string | null
  legalName: string | null
  domain: string
  domainAliases: string[]
  site: { phoneNumbers: string[]; emailAddresses: string[] }
  category: {
    sector: string | null
    industryGroup: string | null
    industry: string | null
    subIndustry: string | null
    sicCode: string | null
    naicsCode: string | null
  }
  tags: string[]
  description: string | null
  foundedYear: number | null
  location: string | null
  timeZone: string | null
  geo: {
    streetNumber: string | null
    streetName: string | null
    subPremise: string | null
    city: string | null
    postalCode: string | null
    state: string | null
    stateCode: string | null
    country: string | null
    countryCode: string | null
    lat: number | null
    lng: number | null
  }
  logo: string | null
  facebook: { handle: string | null }
  linkedin: { handle: string | null }
  twitter: { handle: string | null; followers: number | null }
  crunchbase: { handle: string | null }
  emailProvider: boolean
  type: string | null
  ticker: string | null
  identifiers: { usEIN: string | null }
  phone: string | null
  metrics: {
    alexaUsRank: number | null
    alexaGlobalRank: number | null
    employees: number | null
    employeesRange: string | null
    marketCap: number | null
    raised: number | null
    annualRevenue: number | null
    estimatedAnnualRevenue: string | null
    fiscalYearEnd: number | null
  }
  indexedAt: string
  tech: string[]
  techCategories: string[]
  parent: { domain: string | null }
  ultimateParent: { domain: string | null }
}
