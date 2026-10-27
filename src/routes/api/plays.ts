/**
 * plays.ts — durable human review and "needs attention".
 *   GET  /api/approvals               plays waiting for a person (paused), oldest first
 *   POST /api/plays/:id/approve       { repId?, note? }  (admin) → resume-play job
 *   POST /api/plays/:id/reject        { note? }          (admin) → resume-play job
 *   GET  /api/attention               waiting for review + missed response time + escalated
 *
 * Approve/reject are idempotent: the first decision is claimed atomically on play_instance;
 * repeating the same decision re-enqueues the same job id (no duplicate work), a different
 * decision gets 409. A play in another workspace is 404. Admin-only writes come from
 * ADMIN_WRITE_PREFIXES ('/api/plays') in app.ts. The API exposes our rep ids, never
 * Salesforce user ids.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { writeEvent } from '../../events/event-log.js'
import { buildDecisionSnapshot } from '../../evidence/context-builder.js'
import { listReps } from '../../repositories/reps.repository.js'
import {
  getPlayForReview, claimReviewDecision, listAwaitingReview, listSlaBreachedUncontacted,
  listEscalatedUncontacted, getLeadBriefs, type ReviewPlayRow, type LeadBrief,
} from '../../repositories/play-review.repository.js'
import { resumeJobId, type ResumePlayJob } from '../../queue/jobs/resume-play.js'
import type { ReviewDecision } from '../../domain/db-types.js'

type Deps = { enqueueResume: (job: ResumePlayJob) => Promise<void> }

const defaultDeps: Deps = {
  async enqueueResume(job) {
    // Lazy: importing the queue opens a Redis connection, which the API only needs here.
    const { addJob } = await import('../../queue/setup.js')
    await addJob('resume-play', job, { jobId: resumeJobId(job.playId, job.decidedAt) })
  },
}

function err(request: FastifyRequest, reply: FastifyReply, status: number, error: string, message: string) {
  return reply.status(status).send({ error, message, requestId: request.id })
}

const leadName = (l: LeadBrief | undefined) =>
  l ? ([l.first_name, l.last_name].filter(Boolean).join(' ') || l.email) : 'Unknown lead'

function presentLead(l: LeadBrief | undefined) {
  return l
    ? { name: leadName(l), email: l.email, title: l.title, company: l.company_name }
    : { name: 'Unknown lead', email: null, title: null, company: null }
}

function presentApproval(p: ReviewPlayRow, leads: Map<string, LeadBrief>) {
  return {
    playId:           p.id,
    leadId:           p.lead_id,
    lead:             presentLead(leads.get(p.lead_id)),
    kind:             p.review_kind ?? 'routing',
    reasonCodes:      p.review_context?.reason_codes ?? [],
    suggestedOwner:   p.review_context?.recommended_owner_name ?? null,
    sequenceName:     p.review_context?.sequence_name ?? null,
    waitingSince:     p.pending_approval_since,
    responseDeadline: p.first_touch_deadline,
    slaBreached:      p.sla_breached,
    decision:         p.review_decision ? { decision: p.review_decision.decision, decidedAt: p.review_decided_at } : null,
  }
}

function presentAttentionItem(p: ReviewPlayRow, leads: Map<string, LeadBrief>, since: string | null) {
  return { playId: p.id, leadId: p.lead_id, leadName: leadName(leads.get(p.lead_id)), since, reason: p.escalation_reason }
}

const LIST_LIMIT = 100
const ATTENTION_LIMIT = 5

export function createApprovalRoutes() {
  return async function approvalRoutes(app: FastifyInstance) {
    app.get('/', async request => {
      const { organizationId } = request.tenantContext
      const { rows, total } = await listAwaitingReview(organizationId, LIST_LIMIT)
      const leads = await getLeadBriefs(organizationId, rows.map(r => r.lead_id))
      return { total, approvals: rows.map(r => presentApproval(r, leads)) }
    })
  }
}

export function createAttentionRoutes() {
  return async function attentionRoutes(app: FastifyInstance) {
    app.get('/', async request => {
      const { organizationId } = request.tenantContext
      const [review, breached, escalated] = await Promise.all([
        listAwaitingReview(organizationId, ATTENTION_LIMIT),
        listSlaBreachedUncontacted(organizationId, ATTENTION_LIMIT),
        listEscalatedUncontacted(organizationId, ATTENTION_LIMIT),
      ])
      const leads = await getLeadBriefs(organizationId, [...review.rows, ...breached.rows, ...escalated.rows].map(r => r.lead_id))
      return {
        awaitingReview: { total: review.total,    items: review.rows.map(r => presentAttentionItem(r, leads, r.pending_approval_since)) },
        slaBreached:    { total: breached.total,  items: breached.rows.map(r => presentAttentionItem(r, leads, r.sla_breached_at)) },
        escalated:      { total: escalated.total, items: escalated.rows.map(r => presentAttentionItem(r, leads, r.escalated_at)) },
      }
    })
  }
}

const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }
const note = { type: 'string', maxLength: 1000 }

export function createPlayRoutes(deps: Deps = defaultDeps) {
  return async function playRoutes(app: FastifyInstance) {
    async function decide(request: FastifyRequest, reply: FastifyReply, decision: 'approved' | 'rejected') {
      const { organizationId, userId } = request.tenantContext
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { repId?: string; note?: string }

      const play = await getPlayForReview(organizationId, id)
      if (!play) return err(request, reply, 404, 'NOT_FOUND', 'This lead was not found in your workspace.')
      const kind = play.review_kind ?? 'routing'

      // Already decided: same decision → idempotent (re-enqueue the same job), different → 409.
      if (play.review_decision && play.review_decided_at) {
        if (play.review_decision.decision !== decision) {
          return err(request, reply, 409, 'REVIEW_ALREADY_DECIDED',
            `Someone already ${play.review_decision.decision === 'approved' ? 'approved' : 'rejected'} this lead.`)
        }
        if (play.status === 'paused' || play.status === 'running') {
          await deps.enqueueResume({ playId: play.id, organizationId, decidedAt: play.review_decided_at })
        }
        return reply.status(202).send({ status: 'resuming', alreadyDecided: true })
      }
      if (play.status !== 'paused') {
        return err(request, reply, 409, 'PLAY_NOT_AWAITING_REVIEW', 'This lead is not waiting for a review.')
      }

      // Routing approvals need a rep: the one chosen here, or the agent's suggestion.
      let ownerId: string | null = null
      let ownerName: string | null = null
      if (kind === 'routing' && decision === 'approved') {
        if (body.repId) {
          const rep = (await listReps(organizationId)).find(r => r.id === body.repId)
          if (!rep) return err(request, reply, 400, 'REP_NOT_FOUND', 'That rep is not in your workspace.')
          if (rep.metadata?.sf_active !== true) return err(request, reply, 400, 'REP_INACTIVE', 'That rep is no longer active in Salesforce.')
          ownerId = rep.external_id
          ownerName = rep.metadata?.name ?? null
        } else if (play.review_context?.recommended_owner_id) {
          ownerId = play.review_context.recommended_owner_id
          ownerName = play.review_context.recommended_owner_name
        } else {
          return err(request, reply, 400, 'REP_REQUIRED', 'Choose the rep this lead should go to.')
        }
      }

      const reviewDecision: ReviewDecision = {
        decision, kind, owner_id: ownerId, owner_name: ownerName,
        note: body.note?.trim() || null, actor_user_id: userId, decided_at: new Date().toISOString(),
      }
      const claimed = await claimReviewDecision(organizationId, play.id, reviewDecision)
      if (!claimed) return err(request, reply, 409, 'REVIEW_ALREADY_DECIDED', 'Someone else decided this a moment ago. Refresh to see it.')

      const workflowRunId = play.workflow_run_id ?? play.id
      const snapshot = await buildDecisionSnapshot({
        organizationId, leadId: play.lead_id, workflowRunId, agentName: 'human-review', agentVersion: '1.0.0',
      })
      snapshot.humanReviewContext = {
        actorUserId:         userId,
        decision,
        playStateAtDecision: { status: play.status, review_kind: kind, review_context: play.review_context, pending_approval_since: play.pending_approval_since },
      }
      await writeEvent({
        organizationId,
        workflowRunId,
        playInstanceId: play.id,
        leadId:         play.lead_id,
        eventType:      decision === 'approved' ? 'human_approved' : 'human_rejected',
        actorType:      'human',
        actorId:        userId,
        eventStatus:    'success',
        idempotencyKey: `${organizationId}:${workflowRunId}:human_review_decision:${new Date(reviewDecision.decided_at).getTime()}`,
        policyDecision: { decision, review_kind: kind, owner_name: ownerName, note: reviewDecision.note },
        decisionSnapshot: snapshot,
      })
      await deps.enqueueResume({ playId: play.id, organizationId, decidedAt: reviewDecision.decided_at })
      return reply.status(202).send({ status: 'resuming', alreadyDecided: false })
    }

    app.post('/:id/approve', {
      schema: {
        params: uuidParam,
        body: { type: ['object', 'null'], additionalProperties: false, properties: { repId: { type: 'string', format: 'uuid' }, note } },
      },
    }, (request, reply) => decide(request, reply, 'approved'))

    app.post('/:id/reject', {
      schema: {
        params: uuidParam,
        body: { type: ['object', 'null'], additionalProperties: false, properties: { note } },
      },
    }, (request, reply) => decide(request, reply, 'rejected'))
  }
}
