/**
 * evidence-store.ts
 * Writes enrichment results as evidence rows.
 *
 * Design contract:
 * - NEVER returns [] silently when inputs are null. Callers must guard before calling.
 *   If called with null inputs, this function throws so the bug is visible immediately.
 * - Throws on DB write failure — never swallows errors.
 * - Returns the rows that were actually written (not just a count).
 * - Each logical fact becomes a separate row for granular querying.
 *
 * Evidence rows:
 *   source_type: 'clearbit_person' | 'clearbit_company' (Clearbit)
 *                'zoominfo_enrichment' (ZoomInfo — future)
 *   expires_at:  NOW() + 30 days (Clearbit data stales after ~30 days)
 *   is_current:  true on insert
 *
 * Callers are responsible for distinguishing:
 *   null return from enrichment provider = no match (log enrichment_skipped)
 *   throw from enrichment provider       = API failure (log enrichment_failed)
 * This function only handles the "data exists, write it" case.
 */

import { getDb } from '../db/client.js'
import type { ClearbitPerson, ClearbitCompany } from '../connectors/clearbit/clearbit.types.js'
import type { Evidence } from '../domain/db-types.js'

function thirtyDaysFromNow(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
}

// ─── Fact extraction ──────────────────────────────────────────────────────────

type EvidenceFact = {
  source_type: 'clearbit_person' | 'clearbit_company'
  data: Record<string, unknown>
}

function extractPersonFacts(person: ClearbitPerson): EvidenceFact[] {
  const facts: EvidenceFact[] = []

  if (person.employment?.title) {
    facts.push({ source_type: 'clearbit_person', data: { fact_type: 'employment_title', fact_value: person.employment.title } })
  }
  if (person.employment?.seniority) {
    facts.push({ source_type: 'clearbit_person', data: { fact_type: 'employment_seniority', fact_value: person.employment.seniority } })
  }
  if (person.employment?.role) {
    facts.push({ source_type: 'clearbit_person', data: { fact_type: 'employment_role', fact_value: person.employment.role } })
  }
  if (person.location) {
    facts.push({ source_type: 'clearbit_person', data: { fact_type: 'person_location', fact_value: person.location } })
  }

  return facts
}

function extractCompanyFacts(company: ClearbitCompany): EvidenceFact[] {
  const facts: EvidenceFact[] = []

  const metrics = (company as any).metrics
  if (metrics?.employees != null) {
    facts.push({ source_type: 'clearbit_company', data: { fact_type: 'company_employee_count', fact_value: metrics.employees } })
  }
  if (company.category?.industry) {
    facts.push({ source_type: 'clearbit_company', data: { fact_type: 'company_industry', fact_value: company.category.industry } })
  }
  if (metrics?.estimatedAnnualRevenue != null) {
    facts.push({ source_type: 'clearbit_company', data: { fact_type: 'company_annual_revenue', fact_value: metrics.estimatedAnnualRevenue } })
  }
  const geo = (company as any).geo
  if (geo?.country) {
    facts.push({ source_type: 'clearbit_company', data: { fact_type: 'company_country', fact_value: geo.country } })
  }
  if ((company as any).type) {
    facts.push({ source_type: 'clearbit_company', data: { fact_type: 'company_type', fact_value: (company as any).type } })
  }
  if (company.tags?.length) {
    facts.push({ source_type: 'clearbit_company', data: { fact_type: 'company_tags', fact_value: company.tags } })
  }

  return facts
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Stores Clearbit enrichment results as evidence rows.
 *
 * REQUIRES at least one of clearbitPerson or clearbitCompany to be non-null.
 * Throws if both are null — callers must guard this condition before calling.
 * The null case has a specific meaning (no enrichment match) and must be logged
 * by the caller using enrichment_skipped, not silently ignored here.
 *
 * @param source - string label for logging, e.g. 'clearbit'
 */
export async function storeEnrichmentEvidence(
  organizationId: string,
  leadId: string,
  companyId: string | null,
  clearbitPerson: ClearbitPerson | null,
  clearbitCompany: ClearbitCompany | null,
  source: string = 'clearbit',
): Promise<Evidence[]> {
  // Guard: caller must not call this with null inputs.
  // If you're here with both null, you have a bug in the caller —
  // the null case is "no match found" and should have been handled upstream.
  if (!clearbitPerson && !clearbitCompany) {
    throw new Error(
      `[evidence-store] storeEnrichmentEvidence called with both clearbitPerson=null and clearbitCompany=null ` +
      `(source=${source}, lead=${leadId}, org=${organizationId}). ` +
      `This indicates the caller did not check the enrichment result before calling store. ` +
      `Null enrichment results (no-match) must be logged as enrichment_skipped by the caller, ` +
      `not passed through to evidence storage.`
    )
  }

  const now      = new Date().toISOString()
  const expiresAt = thirtyDaysFromNow()

  const allFacts: EvidenceFact[] = [
    ...(clearbitPerson  ? extractPersonFacts(clearbitPerson)   : []),
    ...(clearbitCompany ? extractCompanyFacts(clearbitCompany) : []),
  ]

  if (allFacts.length === 0) {
    // Data was returned but no facts could be extracted (all fields null).
    // This is a degraded-but-valid result: log and return empty, but do NOT throw.
    console.warn(
      `[evidence-store] Enrichment data received from ${source} for lead ${leadId} but ` +
      `no extractable facts found (all tracked fields are null). ` +
      `0 evidence rows written. Check whether the enrichment response has useful fields.`
    )
    return []
  }

  const rows = allFacts.map((fact) => ({
    organization_id: organizationId,
    lead_id:         leadId,
    company_id:      companyId,
    source_type:     fact.source_type,
    source_id:       clearbitPerson?.id ?? clearbitCompany?.id ?? null,
    data:            fact.data,
    is_current:      true,
    collected_at:    now,
    expires_at:      expiresAt,
  }))

  const { data, error } = await getDb()
    .from('evidence')
    .insert(rows)
    .select()

  if (error) throw new Error(`[evidence-store] storeEnrichmentEvidence DB write failed (source=${source}): ${error.message}`)

  console.info(
    `[evidence-store] Wrote ${(data ?? []).length} evidence rows for lead ${leadId} from ${source} ` +
    `(ids: ${(data ?? []).map((r: any) => r.id).join(', ')}).`
  )

  return (data ?? []) as Evidence[]
}

export async function getLeadEvidence(
  organizationId: string,
  leadId: string
): Promise<Evidence[]> {
  const { data, error } = await getDb()
    .from('evidence')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('lead_id', leadId)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order('collected_at', { ascending: false })

  if (error) throw new Error(`[evidence-store] getLeadEvidence failed: ${error.message}`)
  return (data ?? []) as Evidence[]
}

// ─── Apollo Enrichment ────────────────────────────────────────────────────────
// Separate from Clearbit's function — different field names, different fact extraction.
// source_type = 'apollo_enrichment' (single row type, not split person/company).

/**
 * Stores Apollo people/match enrichment as evidence rows.
 *
 * Each logical fact from the response becomes one row, for granular querying.
 * The full raw Apollo response is stored in the first row's `data._raw` for audit.
 *
 * Facts extracted (based on REAL Apollo response shape, not documentation examples):
 *   apollo_person_title          → person.title (current job title)
 *   apollo_person_location       → person.{city, state, country}
 *   apollo_person_linkedin       → person.linkedin_url
 *   apollo_person_match_meta     → {match_confidence, apollo_id, email_status}
 *   apollo_company_firmographics → org.{name, domain, industry, employee_count,
 *                                       annual_revenue, funding_stage, country}
 *
 * REQUIRES: match is non-null (caller must guard match_confidence !== 'none' before calling).
 * Throws if called with null — same contract as storeEnrichmentEvidence.
 */
export async function storeApolloEnrichmentEvidence(
  organizationId: string,
  leadId:         string,
  companyId:      string | null,
  match:          import('../connectors/apollo/apollo.types.js').ApolloPersonMatch | null,
): Promise<Evidence[]> {
  if (!match) {
    throw new Error(
      `[evidence-store] storeApolloEnrichmentEvidence called with null match ` +
      `(lead=${leadId}, org=${organizationId}). ` +
      `The null case (match_confidence='none') must be handled by the caller as enrichment_skipped. ` +
      `Do not pass null here.`
    )
  }

  const now       = new Date().toISOString()
  const expiresAt = thirtyDaysFromNow()
  const sourceId  = match.apolloId

  // Build fact rows from the real Apollo response fields.
  // Each fact is independently queryable; the _raw is on match_meta for full audit trail.
  const facts: Array<{ fact_type: string; fact_value: unknown }> = []

  if (match.title) {
    facts.push({ fact_type: 'apollo_person_title', fact_value: match.title })
  }

  if (match.location.city || match.location.state || match.location.country) {
    facts.push({
      fact_type: 'apollo_person_location',
      fact_value: {
        city:    match.location.city,
        state:   match.location.state,
        country: match.location.country,
      },
    })
  }

  if (match.linkedinUrl) {
    facts.push({ fact_type: 'apollo_person_linkedin', fact_value: match.linkedinUrl })
  }

  // Always write match metadata + raw response (even if title/location are null)
  // This is the audit row — it proves Apollo was called and what it returned.
  facts.push({
    fact_type: 'apollo_person_match_meta',
    fact_value: {
      apolloId:        match.apolloId,
      matchConfidence: match.matchConfidence,
      emailStatus:     match._raw.email_status ?? null,
      _raw:            match._raw,              // full raw Apollo response
    },
  })

  if (match.company) {
    facts.push({
      fact_type: 'apollo_company_firmographics',
      fact_value: {
        apolloOrgId:   match.company.apolloOrgId,
        name:          match.company.name,
        domain:        match.company.domain,
        industry:      match.company.industry,
        employeeCount: match.company.employeeCount,
        annualRevenue: match.company.annualRevenue,
        fundingStage:  match.company.fundingStage,
        country:       match.company.country,
      },
    })
  }

  if (facts.length === 0) {
    console.warn(
      `[evidence-store] Apollo match returned for lead ${leadId} ` +
      `(apolloId=${match.apolloId}, confidence=${match.matchConfidence}) ` +
      `but no extractable facts found. 0 rows written.`
    )
    return []
  }

  const rows = facts.map(f => ({
    organization_id: organizationId,
    lead_id:         leadId,
    company_id:      companyId,
    source_type:     'apollo_enrichment' as const,
    source_id:       sourceId,
    data:            f,
    is_current:      true,
    collected_at:    now,
    expires_at:      expiresAt,
  }))

  const { data, error } = await getDb()
    .from('evidence')
    .insert(rows)
    .select()

  if (error) throw new Error(`[evidence-store] storeApolloEnrichmentEvidence DB write failed: ${error.message}`)

  console.info(
    `[evidence-store] Wrote ${(data ?? []).length} Apollo evidence rows for lead ${leadId} ` +
    `(apolloId=${match.apolloId}, confidence=${match.matchConfidence}, ` +
    `ids: ${(data ?? []).map((r: any) => r.id).join(', ')}).`
  )

  return (data ?? []) as Evidence[]
}

// ─── Apollo Organization Enrichment ──────────────────────────────────────────
// Stores results from GET /api/v1/organizations/enrich (company-level only).
// source_type = 'apollo_enrichment' (reuses same DB enum value).
//
// PLAN SCOPE NOTE: Apollo org endpoint provides company-level data only.
// No person-level data (title, seniority, role) is available on this plan.
// Apollo is used for company data only (no person-level enrichment).
//
// CONFIDENCE: APOLLO_ORG_ENRICHMENT_CONFIDENCE = 0.82 — static, not dynamic.

/**
 * Static confidence score for Apollo organization enrichment.
 * 0.82 — static, not dynamic, not field-level.
 * Slightly below person-level Apollo score (0.85) because org data is less directly
 * actionable for ICP scoring (we lose person-level signals entirely on this plan).
 */
export const APOLLO_ORG_ENRICHMENT_CONFIDENCE = 0.82

/**
 * Stores Apollo organizations/enrich results as evidence rows.
 *
 * Facts extracted (field names VERIFIED against real stripe.com response, 2026-10-05):
 *   apollo_org_firmographics  → id, name, primary_domain, industry, industries,
 *                               estimated_num_employees, organization_revenue, founded_year,
 *                               city, state, country (top-level — NOT nested under geo)
 *   apollo_org_funding        → total_funding, latest_funding_stage, latest_funding_round_date
 *   apollo_org_tech_stack     → technology_names (list of tech stack items)
 *   apollo_org_identity       → full _raw response for audit/replay
 *
 * REQUIRES: match is non-null (caller must guard: org endpoint returns {} for no-match).
 * Throws if called with null — same contract as storeEnrichmentEvidence.
 */
export async function storeApolloOrgEnrichmentEvidence(
  organizationId: string,
  leadId:         string,
  companyId:      string | null,
  match:          import('../connectors/apollo/apollo.types.js').ApolloOrganizationMatch | null,
): Promise<Evidence[]> {
  if (!match) {
    throw new Error(
      `[evidence-store] storeApolloOrgEnrichmentEvidence called with null match ` +
      `(lead=${leadId}, org=${organizationId}). ` +
      `The null case (Apollo org endpoint returned {}) must be handled by the caller as enrichment_skipped. ` +
      `Do not pass null here.`
    )
  }

  const now       = new Date().toISOString()
  const expiresAt = thirtyDaysFromNow()
  const sourceId  = match.apolloOrgId

  const facts: Array<{ fact_type: string; fact_value: unknown }> = []

  // Firmographics — the primary fact for ICP scoring.
  // Field names verified against real stripe.com response (2026-10-05).
  facts.push({
    fact_type: 'apollo_org_firmographics',
    fact_value: {
      apolloOrgId:    match.apolloOrgId,
      name:           match.name,
      domain:         match.domain,
      industry:       match.industry,
      industries:     match.industries,
      employeeCount:  match.employeeCount,    // estimated_num_employees in raw
      revenue:        match.revenue,           // organization_revenue in raw (verified)
      revenuePrinted: match.revenuePrinted,
      foundedYear:    match.foundedYear,
      city:           match.location.city,     // top-level in raw, not nested under geo
      state:          match.location.state,
      country:        match.location.country,
    },
  })

  // Funding — separate row for independent querying
  if (match.fundingStage || match.totalFunding) {
    facts.push({
      fact_type: 'apollo_org_funding',
      fact_value: {
        totalFunding:    match.totalFunding,
        fundingStage:    match.fundingStage,
        apolloOrgId:     match.apolloOrgId,
      },
    })
  }

  // Tech stack — separate row (can be large; isolate for querying)
  if (match.techStack.length > 0) {
    facts.push({
      fact_type: 'apollo_org_tech_stack',
      fact_value: {
        techStack:   match.techStack,
        apolloOrgId: match.apolloOrgId,
      },
    })
  }

  // Identity row — always written, preserves full _raw for audit/replay
  facts.push({
    fact_type: 'apollo_org_identity',
    fact_value: {
      apolloOrgId: match.apolloOrgId,
      _raw: match._raw,
    },
  })

  const rows = facts.map(f => ({
    organization_id: organizationId,
    lead_id:         leadId,
    company_id:      companyId,
    source_type:     'apollo_enrichment' as const,
    source_id:       sourceId,
    data:            f,
    is_current:      true,
    collected_at:    now,
    expires_at:      expiresAt,
  }))

  const { data, error } = await getDb()
    .from('evidence')
    .insert(rows)
    .select()

  if (error) throw new Error(`[evidence-store] storeApolloOrgEnrichmentEvidence DB write failed: ${error.message}`)

  console.info(
    `[evidence-store] Wrote ${(data ?? []).length} Apollo org evidence rows for lead ${leadId} ` +
    `(apolloOrgId=${match.apolloOrgId}, domain=${match.domain}, ` +
    `ids: ${(data ?? []).map((r: any) => r.id).join(', ')}).`
  )

  return (data ?? []) as Evidence[]
}
