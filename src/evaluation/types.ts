/**
 * types.ts — golden dataset shape.
 *
 * A golden case is plain, JSON-serialisable data: what a lead looked like, which ideal-customer
 * and routing settings applied, and the decision a careful human would make. It is the yardstick
 * for any decision-maker (v1 rules, a v2 model) and is replayed by the simulator (replay.ts).
 *
 * `expected` is the human-correct answer, NOT "whatever v1 does". Where v1 rules get it wrong
 * the case lists the area in `v1Disagrees`; those cases are where a model can earn its keep.
 */

import type { IcpTier } from '../agents/qualification/types.js'
import type { RoutingFailure } from '../agents/routing/rules.js'
import type { IcpConfig } from '../agents/qualification/icp-config.js'

export type GoldenLead = {
  email: string
  first_name?: string | null
  last_name?: string | null
  title?: string | null
  source: string                              // e.g. 'hubspot:Request a demo'
  raw_payload?: Record<string, unknown> | null // untrusted form fields
}

export type GoldenCompany = {
  name?: string | null
  domain?: string | null
  industry?: string | null
  employee_count?: number | null
  country?: string | null
}

export type GoldenTerritory = {
  queue: string
  countries: string[] | 'all'
  ownerIds: string[] | null                   // null = every rep
}

export type GoldenOwner = { id: string; name: string; active: boolean; available: boolean }

export type GoldenRoutingSetup = {
  territories?: GoldenTerritory[]             // default: GOLDEN_TERRITORIES
  owners?: GoldenOwner[]                      // default: GOLDEN_OWNERS
  workloads: Record<string, number>
  roundRobinCounter: number
  maxOpenLeadsPerRep?: number                 // default: 25
}

export type ExpectedRouting =
  | { action: 'assign_owner'; ownerId: string; queue: string }
  | { action: 'request_human_review'; reason: RoutingFailure }

export type GoldenCase = {
  id: string                                  // stable, kebab-case; never reuse
  description: string
  tags: string[]
  origin: 'live' | 'synthetic'               // live = shape taken from a real verified run (anonymised)
  lead: GoldenLead
  company: GoldenCompany | null               // null = enrichment returned nothing
  icpOverrides?: Partial<IcpConfig>           // applied on top of DEFAULT_ICP_CONFIG
  routing?: GoldenRoutingSetup                // only for leads that should be routed
  expected: {
    tier: IcpTier
    acceptableTiers?: IcpTier[]               // borderline: any of these counts as agreement (must include tier)
    reasonCodesPresent?: string[]             // checked against v1 only, and only where v1 agrees
    routing?: ExpectedRouting
  }
  v1Disagrees?: Array<'qualification' | 'routing'>
  notes?: string
}
