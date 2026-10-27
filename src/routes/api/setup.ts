/**
 * setup.ts — the setup wizard's checklist.
 *
 *   GET  /api/setup            → each step and whether it is done (read from real state, nothing stored)
 *   POST /api/setup/complete   (admin) → stamp organizations.setup_completed_at once every
 *                                        required step is done; 409 SETUP_INCOMPLETE otherwise
 *
 * Required: HubSpot, Salesforce, at least one rep taking leads, a test lead sent.
 * Recommended (shown, not enforced): Apollo, ideal customer reviewed, outreach chosen.
 */

import type { FastifyInstance } from 'fastify'
import { describeConnector, type V1ConnectorName } from '../../repositories/connector-credentials.repository.js'
import { listReps, listActivePolicies } from '../../repositories/reps.repository.js'
import { getActiveIcpPolicy } from '../../repositories/icp-policy.repository.js'
import { countTestLeads } from '../../repositories/test-lead.repository.js'
import { getSetupCompletedAt, markSetupCompleted } from '../../repositories/setup.repository.js'
import { parseOutreachConfig, OUTREACH_TIERS } from '../../policies/outreach-policy.js'

export type SetupStepKey = 'hubspot' | 'salesforce' | 'apollo' | 'reps' | 'ideal_customer' | 'outreach' | 'test_lead'

export type SetupStep = {
  key: SetupStepKey
  required: boolean
  done: boolean
  /** Facts the page uses to word the step (counts, statuses). */
  facts: Record<string, string | number | boolean | null>
}

const STEP_LABELS: Record<SetupStepKey, string> = {
  hubspot:        'Connect HubSpot',
  salesforce:     'Connect Salesforce',
  apollo:         'Connect Apollo',
  reps:           'Import your reps',
  ideal_customer: 'Review your ideal customer',
  outreach:       'Choose outreach',
  test_lead:      'Send a test lead',
}

async function connectorStep(orgId: string, key: V1ConnectorName, required: boolean): Promise<SetupStep> {
  const d = await describeConnector(orgId, key)
  const status = !d.configured ? 'not_connected' : d.healthStatus === 'error' ? 'needs_attention' : 'connected'
  return { key, required, done: status === 'connected', facts: { status } }
}

export async function loadSetupSteps(orgId: string): Promise<SetupStep[]> {
  const [hubspot, salesforce, apollo, reps, icp, outreachRules, testLeads] = await Promise.all([
    connectorStep(orgId, 'hubspot', true),
    connectorStep(orgId, 'salesforce', true),
    connectorStep(orgId, 'apollo', false),
    listReps(orgId),
    getActiveIcpPolicy(orgId),
    listActivePolicies(orgId, 'outreach'),
    countTestLeads(orgId),
  ])

  const takingLeads = reps.filter(r => r.metadata?.sf_active === true && r.metadata?.available === true).length

  let tiersChosen = 0
  let outreachValid = false
  if (outreachRules[0]) {
    try {
      const config = parseOutreachConfig(outreachRules[0].actions)
      outreachValid = true
      tiersChosen = OUTREACH_TIERS.filter(t => config.tiers[t] !== null).length
    } catch { /* invalid saved config → not done; the Outreach page explains */ }
  }

  return [
    hubspot,
    salesforce,
    apollo,
    { key: 'reps', required: true, done: takingLeads > 0, facts: { reps: reps.length, takingLeads } },
    // Seeded at version 1; saving on the Ideal customer page bumps it.
    { key: 'ideal_customer', required: false, done: (icp?.version ?? 0) > 1, facts: { exists: icp !== null, version: icp?.version ?? null } },
    { key: 'outreach', required: false, done: outreachValid && tiersChosen === OUTREACH_TIERS.length, facts: { valid: outreachValid, tiersChosen, tiers: OUTREACH_TIERS.length } },
    { key: 'test_lead', required: true, done: testLeads > 0, facts: { sent: testLeads } },
  ]
}

export async function setupRoutes(app: FastifyInstance) {
  app.get('/', async request => {
    const { organizationId } = request.tenantContext
    const [steps, completedAt] = await Promise.all([loadSetupSteps(organizationId), getSetupCompletedAt(organizationId)])
    return { completedAt, canFinish: steps.every(s => !s.required || s.done), steps }
  })

  app.post('/complete', async (request, reply) => {
    const { organizationId, role } = request.tenantContext
    if (role !== 'admin') {
      return reply.status(403).send({ error: 'ADMIN_REQUIRED', message: 'Only workspace admins can finish setup.', requestId: request.id })
    }
    const steps = await loadSetupSteps(organizationId)
    const missing = steps.filter(s => s.required && !s.done)
    if (missing.length) {
      return reply.status(409).send({
        error: 'SETUP_INCOMPLETE',
        message: `Finish these steps first: ${missing.map(s => STEP_LABELS[s.key]).join(', ')}.`,
        missing: missing.map(s => s.key),
        requestId: request.id,
      })
    }
    const completedAt = await markSetupCompleted(organizationId, new Date().toISOString())
    return reply.send({ completedAt })
  })
}
