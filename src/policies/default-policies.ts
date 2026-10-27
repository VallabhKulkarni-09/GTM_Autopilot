/**
 * default-policies.ts — the single place where a new workspace's starting policies are defined.
 * Every value is explicit and editable in the web app; nothing downstream silently defaults.
 */

import { getDb } from '../db/client.js'
import { DEFAULT_ICP_CONFIG } from '../agents/qualification/icp-config.js'
import { EMPTY_OUTREACH_CONFIG } from './outreach-policy.js'

export type PolicySeed = {
  rule_type: string
  name: string
  description: string
  conditions: Record<string, unknown>
  actions: Record<string, unknown> | null
  priority: number
}

export const DEFAULT_POLICIES: PolicySeed[] = [
  {
    rule_type: 'sla',
    name: 'First response time',
    description: 'How quickly a new lead must be contacted after they submit the form.',
    conditions: {},
    actions: { sla_minutes: 15 },
    priority: 10,
  },
  {
    rule_type: 'icp_filter',
    name: 'Ideal customer',
    description: 'Which companies and people are a good fit, and how fit is scored.',
    conditions: { ...DEFAULT_ICP_CONFIG },
    actions: null,
    priority: 30,
  },
  {
    rule_type: 'routing',
    name: 'Lead assignment',
    description: 'The most open leads a rep can hold before new leads skip them.',
    conditions: {},
    actions: { max_open_leads_per_rep: 25 },
    priority: 40,
  },
  {
    // Apollo IDs only the user can choose: explicitly "not set up yet" until picked.
    rule_type: 'outreach',
    name: 'Outreach',
    description: 'Which Apollo sequence each fit level goes into, and the mailbox that sends it.',
    conditions: {},
    actions: { ...EMPTY_OUTREACH_CONFIG, tiers: { ...EMPTY_OUTREACH_CONFIG.tiers } },
    priority: 50,
  },
  {
    rule_type: 'territory',
    name: 'Everywhere',
    description: 'Leads from anywhere go to all reps, shared evenly.',
    conditions: { operator: 'all' },
    actions: { queue_name: 'everywhere', owner_ids: null },
    priority: 1000,
  },
  {
    rule_type: 'outcome_detection',
    name: 'Meeting detection',
    description: 'How a booked meeting is recognised in Salesforce, and how long to wait for one.',
    conditions: {
      primary_meeting_types: ['Meeting'],
      attribution_window_days: 14,
      supportive_lead_statuses: [],
      supportive_checkbox_field: null,
      supportive_opportunity_stage_keywords: [],
    },
    actions: null,
    priority: 20,
  },
  {
    rule_type: 're_enrollment',
    name: 'Returning leads',
    description: 'A person who fills the form again is treated as new after this many days.',
    conditions: {},
    actions: { allow_after_days: 90 },
    priority: 100,
  },
]

/** Inserts the default policies for a brand-new workspace. */
export async function seedDefaultPolicies(organizationId: string, seeds: PolicySeed[] = DEFAULT_POLICIES): Promise<void> {
  const rows = seeds.map(p => ({ organization_id: organizationId, is_active: true, ...p }))
  const { error } = await getDb().from('policy_rules').insert(rows)
  if (error) throw new Error(`seedDefaultPolicies failed: ${error.message}`)
}
