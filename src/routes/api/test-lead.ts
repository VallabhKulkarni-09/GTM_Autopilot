/**
 * test-lead.ts — send a made-up lead through the real pipeline from the setup page.
 *
 *   POST   /api/test-lead   (admin) → enqueue an inbound lead marked is_test
 *   GET    /api/test-lead           → this workspace's test leads that have not been removed
 *   DELETE /api/test-lead   (admin) → remove (hide) every test lead
 *
 * A test lead runs exactly like a HubSpot form submission: company lookup, fit score, routing
 * (real Salesforce Lead + Task when connected) and outreach (a real Apollo sequence when one is
 * set for its fit level). The only differences: it skips the HubSpot contact fetch (the details
 * are in the payload), metrics and duplicate checks ignore it, and the timeline shows it was sent
 * by the admin. Records it created in Salesforce/Apollo are NOT removed by DELETE.
 *
 * The workspace always comes from the verified user (tenantContext), never the body.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { randomUUID } from 'crypto'
import { listTestLeads, listTestPlays, removeTestLeads } from '../../repositories/test-lead.repository.js'

export type TestLeadJob = {
  payload: {
    eventId: string
    subscriptionType: 'test_lead'
    occurredAt: number            // epoch ms — becomes form_submitted_at (the SLA clock start)
    properties: { email: string; firstname: string | null; lastname: string | null; jobtitle: string | null }
  }
  organizationId: string
  idempotencyKey: string
  isTest: true
  requestedBy: string
  receivedAt: string
}

type Deps = { enqueue: (job: TestLeadJob) => Promise<void> }

const defaultDeps: Deps = {
  async enqueue(job) {
    // Lazy: importing the queue opens a Redis connection, which the API only needs here.
    const { addJob } = await import('../../queue/setup.js')
    await addJob('inbound-lead-processing', job as unknown as Record<string, unknown>, { priority: 2 })
  },
}

const postBody = {
  type: 'object',
  required: ['email'],
  additionalProperties: false,
  properties: {
    email:     { type: 'string', format: 'email', maxLength: 320 },
    firstName: { type: 'string', maxLength: 120 },
    lastName:  { type: 'string', maxLength: 120 },
    title:     { type: 'string', maxLength: 200 },
  },
}

type PostBody = { email: string; firstName?: string; lastName?: string; title?: string }

function err(request: FastifyRequest, reply: FastifyReply, status: number, error: string, message: string) {
  return reply.status(status).send({ error, message, requestId: request.id })
}

const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : null)

export function createTestLeadRoutes(deps: Deps = defaultDeps) {
  return async function testLeadRoutes(app: FastifyInstance) {
    app.post('/', { schema: { body: postBody } }, async (request, reply) => {
      const { organizationId, userId, role } = request.tenantContext
      if (role !== 'admin') return err(request, reply, 403, 'ADMIN_REQUIRED', 'Only workspace admins can send a test lead.')
      const body = request.body as PostBody

      const occurredAt = Date.now()
      const eventId = `test-${randomUUID()}`
      const job: TestLeadJob = {
        payload: {
          eventId,
          subscriptionType: 'test_lead',
          occurredAt,
          properties: {
            email:     body.email.trim().toLowerCase(),
            firstname: clean(body.firstName),
            lastname:  clean(body.lastName),
            jobtitle:  clean(body.title),
          },
        },
        organizationId,
        idempotencyKey: `test-lead:${organizationId}:${eventId}`,
        isTest: true,
        requestedBy: userId,
        receivedAt: new Date(occurredAt).toISOString(),
      }

      try {
        await deps.enqueue(job)
      } catch (e) {
        request.log.error({ err: e }, 'test lead enqueue failed')
        return err(request, reply, 503, 'QUEUE_UNAVAILABLE', 'The test lead could not be sent because the background worker queue is not reachable. Check that Redis is running, then try again.')
      }
      return reply.status(202).send({ status: 'queued', email: job.payload.properties.email, submittedAt: job.receivedAt })
    })

    app.get('/', async request => {
      const { organizationId } = request.tenantContext
      const leads = await listTestLeads(organizationId, 10)
      const plays = await listTestPlays(organizationId, leads.map(l => l.id))
      const latest = new Map<string, (typeof plays)[number]>()
      for (const p of plays) if (!latest.has(p.lead_id)) latest.set(p.lead_id, p)
      return {
        leads: leads.map(l => {
          const play = latest.get(l.id)
          return {
            id:          l.id,
            name:        [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email,
            email:       l.email,
            stage:       l.stage,
            fit:         l.icp_tier,
            submittedAt: l.form_submitted_at,
            playStatus:  play?.status ?? null,
            owner:       play?.assigned_owner_name ?? null,
          }
        }),
      }
    })

    app.delete('/', async (request, reply) => {
      const { organizationId, role } = request.tenantContext
      if (role !== 'admin') return err(request, reply, 403, 'ADMIN_REQUIRED', 'Only workspace admins can remove test leads.')
      const removed = await removeTestLeads(organizationId, new Date().toISOString())
      return reply.send({ removed })
    })
  }
}
