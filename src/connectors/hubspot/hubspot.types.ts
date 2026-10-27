/**
 * hubspot.types.ts
 * HubSpot-specific types for the GTM Autopilot connector.
 */

// ─── HubSpot Config ───────────────────────────────────────────────────────────

export type HubSpotConfig = {
  apiKey: string        // HUBSPOT_API_KEY (Private App token)
  webhookSecret: string // HUBSPOT_WEBHOOK_SECRET
}

// ─── HubSpot Entities ─────────────────────────────────────────────────────────

export type HubSpotContact = {
  id: string
  properties: {
    email: string
    firstname: string | null
    lastname: string | null
    jobtitle: string | null
    phone: string | null
    company: string | null
    lifecyclestage: string | null
    hs_lead_status: string | null
    createdate: string
    lastmodifieddate: string
  }
  createdAt: string
  updatedAt: string
  archived: boolean
}

// ─── Input Types ──────────────────────────────────────────────────────────────

export type UpdateContactInput = Partial<{
  firstname: string
  lastname: string
  jobtitle: string
  phone: string
  company: string
  lifecyclestage: string
  hs_lead_status: string
  [key: string]: string
}>

// ─── HubSpot API Response Types ───────────────────────────────────────────────

export type HubSpotSearchResponse = {
  total: number
  results: HubSpotContact[]
}

export type HubSpotErrorResponse = {
  status: string
  message: string
  correlationId: string
  category: string
}
