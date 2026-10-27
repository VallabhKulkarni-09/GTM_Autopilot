/**
 * salesforce.types.ts
 * Salesforce-specific types for the GTM Autopilot connector.
 */

// ─── Salesforce Config ─────────────────────────────────────────────────────────

export type SalesforceConfig = {
  instanceUrl: string   // SF_INSTANCE_URL
  clientId: string      // SF_CLIENT_ID
  clientSecret: string  // SF_CLIENT_SECRET
  sandbox: boolean      // SF_SANDBOX
}

// ─── Salesforce Entities ───────────────────────────────────────────────────────

export type SalesforceLead = {
  Id: string
  FirstName: string | null
  LastName: string
  Email: string
  Title: string | null
  Phone: string | null
  Company: string | null
  LeadSource: string | null
  Status: string
  OwnerId: string | null
  CreatedDate: string
  LastModifiedDate: string
}

export type SalesforceTask = {
  Id: string
  WhoId: string        // Lead or Contact ID
  OwnerId: string
  Subject: string
  Status: string
  ActivityDate: string | null
  Description: string | null
  CreatedDate: string
}

export type SalesforceUser = {
  Id: string
  Name: string
  Email: string
  IsActive: boolean
  UserRole: { Name: string } | null
  Profile: { Name: string } | null
}

/**
 * Salesforce Event object — used for meeting detection (outcome tracking).
 * Fields selected: Id, WhoId, Type, Subject, StartDateTime, EndDateTime,
 * ActivityDate, CreatedDate.
 * WhoId links to the Lead or Contact record (same as Task.WhoId).
 */
export type SalesforceEvent = {
  Id: string
  WhoId: string | null
  // NOTE: Event.Type does not exist in this SF org (INVALID_FIELD confirmed via live describe).
  // Removed from type and SOQL. Subject is the primary categorisation field.
  Subject: string | null
  StartDateTime: string
  EndDateTime: string | null
  ActivityDate: string | null
  CreatedDate: string
}

// ─── Input Types ──────────────────────────────────────────────────────────────

export type CreateLeadInput = {
  firstName?: string
  lastName: string
  email: string
  title?: string
  phone?: string
  company?: string
  leadSource?: string
}

export type CreateTaskInput = {
  subject: string
  ownerId: string
  dueDate?: string       // YYYY-MM-DD
  description?: string
  status?: string
}

export type UserFilter = {
  isActive?: boolean
  role?: string
  profile?: string
}

// ─── Salesforce API Response Types ────────────────────────────────────────────

export type SalesforceTokenResponse = {
  access_token: string
  instance_url: string
  token_type: string
}

export type SalesforceQueryResponse<T> = {
  totalSize: number
  done: boolean
  records: T[]
}

export type SalesforceCreateResponse = {
  id: string
  success: boolean
  errors: unknown[]
}
