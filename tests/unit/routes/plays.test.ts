import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const review = vi.hoisted(() => ({
  getPlayForReview: vi.fn(), claimReviewDecision: vi.fn(), markPlayResumed: vi.fn(), markPlayEscalated: vi.fn(),
  listAwaitingReview: vi.fn(), listSlaBreachedUncontacted: vi.fn(), listEscalatedUncontacted: vi.fn(), getLeadBriefs: vi.fn(),
}))
const reps = vi.hoisted(() => ({ listReps: vi.fn() }))
const events = vi.hoisted(() => ({ writeEvent: vi.fn() }))
vi.mock('../../../src/repositories/play-review.repository.js', () => review)
vi.mock('../../../src/repositories/reps.repository.js', () => reps)
vi.mock('../../../src/events/event-log.js', () => events)
vi.mock('../../../src/evidence/context-builder.js', () => ({
  buildDecisionSnapshot: vi.fn(async () => ({ lead: { id: 'lead-1' }, company: null, policies: [], ownerWorkloads: {}, evidenceIds: [], agentName: 'human-review', agentVersion: '1.0.0', promptVersion: null, modelName: null })),
}))

const { createPlayRoutes, createApprovalRoutes, createAttentionRoutes } = await import('../../../src/routes/api/plays.js')

const PLAY = '11111111-1111-4111-8111-111111111111'
const REP = '22222222-2222-4222-8222-222222222222'
const enqueueResume = vi.fn()

const paused = (over = {}) => ({
  id: PLAY, lead_id: 'lead-1', status: 'paused', workflow_run_id: 'run-1', first_touch_deadline: '2026-10-26T10:15:00Z',
  first_touch_at: null, sla_breached: false, sla_breached_at: null, pending_approval_since: '2026-10-26T10:01:00Z',
  review_kind: 'routing', review_context: { reason_codes: ['NO_TERRITORY_MATCH'], queue_name: 'unassigned', recommended_owner_id: null, recommended_owner_name: null },
  review_decision: null, review_decided_at: null, escalated_at: null, escalation_reason: null, assigned_owner_name: null, ...over,
})

async function makeApp(role: 'admin' | 'member' = 'admin') {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async req => { req.tenantContext = { organizationId: 'org-a', userId: 'user-1', role } })
  await app.register(createPlayRoutes({ enqueueResume }), { prefix: '/api/plays' })
  await app.register(createApprovalRoutes(), { prefix: '/api/approvals' })
  await app.register(createAttentionRoutes(), { prefix: '/api/attention' })
  await app.ready()
  return app
}

beforeEach(() => {
  for (const m of [...Object.values(review), ...Object.values(reps), ...Object.values(events)]) m.mockReset()
  enqueueResume.mockReset()
  review.getPlayForReview.mockResolvedValue(paused())
  review.claimReviewDecision.mockImplementation(async (_o: string, _id: string, d: any) => paused({ review_decision: d, review_decided_at: d.decided_at }))
  review.getLeadBriefs.mockResolvedValue(new Map([['lead-1', { id: 'lead-1', email: 'ana@acme.io', first_name: 'Ana', last_name: 'Lee', title: 'VP', company_name: 'Acme' }]]))
  reps.listReps.mockResolvedValue([{ id: REP, external_id: '005REP', metadata: { name: 'Alice Ng', sf_active: true, available: false } }])
})

describe('POST /api/plays/:id/approve', () => {
  it('records the decision with the chosen rep, writes human_approved, enqueues the resume', async () => {
    const res = await (await makeApp()).inject({ method: 'POST', url: `/api/plays/${PLAY}/approve`, payload: { repId: REP, note: 'EMEA cover' } })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'resuming', alreadyDecided: false })
    const decision = review.claimReviewDecision.mock.calls[0][2]
    expect(review.claimReviewDecision.mock.calls[0].slice(0, 2)).toEqual(['org-a', PLAY])
    expect(decision).toMatchObject({ decision: 'approved', kind: 'routing', owner_id: '005REP', owner_name: 'Alice Ng', note: 'EMEA cover', actor_user_id: 'user-1' })
    expect(events.writeEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'human_approved', actorType: 'human', actorId: 'user-1', organizationId: 'org-a', workflowRunId: 'run-1',
      decisionSnapshot: expect.objectContaining({ humanReviewContext: expect.objectContaining({ actorUserId: 'user-1', decision: 'approved' }) }),
    }))
    expect(enqueueResume).toHaveBeenCalledWith({ playId: PLAY, organizationId: 'org-a', decidedAt: decision.decided_at })
    expect(res.body).not.toContain('005REP')
  })

  it('without a rep and no suggestion → 400 REP_REQUIRED, nothing recorded', async () => {
    const res = await (await makeApp()).inject({ method: 'POST', url: `/api/plays/${PLAY}/approve`, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('REP_REQUIRED')
    expect(review.claimReviewDecision).not.toHaveBeenCalled()
  })

  it('uses the suggested owner when no rep is chosen', async () => {
    review.getPlayForReview.mockResolvedValue(paused({ review_context: { reason_codes: [], queue_name: 'na', recommended_owner_id: '005SUG', recommended_owner_name: 'Sam' } }))
    await (await makeApp()).inject({ method: 'POST', url: `/api/plays/${PLAY}/approve` })
    expect(review.claimReviewDecision.mock.calls[0][2]).toMatchObject({ owner_id: '005SUG', owner_name: 'Sam' })
  })

  it('a rep from another workspace → 400 REP_NOT_FOUND', async () => {
    const res = await (await makeApp()).inject({ method: 'POST', url: `/api/plays/${PLAY}/approve`, payload: { repId: '33333333-3333-4333-8333-333333333333' } })
    expect(res.json().error).toBe('REP_NOT_FOUND')
    expect(reps.listReps).toHaveBeenCalledWith('org-a')
  })

  it('a play in another workspace → 404', async () => {
    review.getPlayForReview.mockResolvedValue(null)
    const res = await (await makeApp()).inject({ method: 'POST', url: `/api/plays/${PLAY}/approve`, payload: { repId: REP } })
    expect(res.statusCode).toBe(404)
    expect(review.getPlayForReview).toHaveBeenCalledWith('org-a', PLAY)
  })

  it('repeating the same decision is idempotent: same job, no new event', async () => {
    review.getPlayForReview.mockResolvedValue(paused({ review_decision: { decision: 'approved' }, review_decided_at: '2026-10-26T10:05:00Z' }))
    const res = await (await makeApp()).inject({ method: 'POST', url: `/api/plays/${PLAY}/approve`, payload: { repId: REP } })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'resuming', alreadyDecided: true })
    expect(enqueueResume).toHaveBeenCalledWith({ playId: PLAY, organizationId: 'org-a', decidedAt: '2026-10-26T10:05:00Z' })
    expect(events.writeEvent).not.toHaveBeenCalled()
    expect(review.claimReviewDecision).not.toHaveBeenCalled()
  })

  it('the opposite decision after one was made → 409', async () => {
    review.getPlayForReview.mockResolvedValue(paused({ review_decision: { decision: 'rejected' }, review_decided_at: '2026-10-26T10:05:00Z' }))
    const res = await (await makeApp()).inject({ method: 'POST', url: `/api/plays/${PLAY}/approve`, payload: { repId: REP } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('REVIEW_ALREADY_DECIDED')
  })

  it('losing a race (claim returns null) → 409, no event, no job', async () => {
    review.claimReviewDecision.mockResolvedValue(null)
    const res = await (await makeApp()).inject({ method: 'POST', url: `/api/plays/${PLAY}/approve`, payload: { repId: REP } })
    expect(res.statusCode).toBe(409)
    expect(events.writeEvent).not.toHaveBeenCalled()
    expect(enqueueResume).not.toHaveBeenCalled()
  })

  it('a play that is not paused → 409 PLAY_NOT_AWAITING_REVIEW', async () => {
    review.getPlayForReview.mockResolvedValue(paused({ status: 'running' }))
    const res = await (await makeApp()).inject({ method: 'POST', url: `/api/plays/${PLAY}/approve`, payload: { repId: REP } })
    expect(res.json().error).toBe('PLAY_NOT_AWAITING_REVIEW')
  })
})

describe('POST /api/plays/:id/reject', () => {
  it('records the rejection without a rep and writes human_rejected', async () => {
    const res = await (await makeApp()).inject({ method: 'POST', url: `/api/plays/${PLAY}/reject`, payload: { note: 'spam' } })
    expect(res.statusCode).toBe(202)
    expect(review.claimReviewDecision.mock.calls[0][2]).toMatchObject({ decision: 'rejected', owner_id: null, note: 'spam' })
    expect(events.writeEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'human_rejected', actorType: 'human' }))
    expect(enqueueResume).toHaveBeenCalledOnce()
  })
})

describe('GET /api/approvals and /api/attention', () => {
  it('lists paused plays in plain shapes, scoped to the org', async () => {
    review.listAwaitingReview.mockResolvedValue({ rows: [paused()], total: 1 })
    const res = await (await makeApp('member')).inject({ method: 'GET', url: '/api/approvals' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      total: 1,
      approvals: [{
        playId: PLAY, leadId: 'lead-1', lead: { name: 'Ana Lee', email: 'ana@acme.io', title: 'VP', company: 'Acme' },
        kind: 'routing', reasonCodes: ['NO_TERRITORY_MATCH'], suggestedOwner: null, sequenceName: null,
        waitingSince: '2026-10-26T10:01:00Z', responseDeadline: '2026-10-26T10:15:00Z', slaBreached: false, decision: null,
      }],
    })
    expect(review.listAwaitingReview).toHaveBeenCalledWith('org-a', 100)
    expect(review.getLeadBriefs).toHaveBeenCalledWith('org-a', ['lead-1'])
  })

  it('attention groups: waiting for review, missed response time, escalated', async () => {
    review.listAwaitingReview.mockResolvedValue({ rows: [paused()], total: 3 })
    review.listSlaBreachedUncontacted.mockResolvedValue({ rows: [paused({ status: 'running', sla_breached: true, sla_breached_at: '2026-10-26T10:16:00Z', escalation_reason: 'SLA_BREACHED' })], total: 1 })
    review.listEscalatedUncontacted.mockResolvedValue({ rows: [], total: 0 })
    const res = await (await makeApp('member')).inject({ method: 'GET', url: '/api/attention' })
    expect(res.json()).toEqual({
      awaitingReview: { total: 3, items: [{ playId: PLAY, leadId: 'lead-1', leadName: 'Ana Lee', since: '2026-10-26T10:01:00Z', reason: null }] },
      slaBreached:    { total: 1, items: [{ playId: PLAY, leadId: 'lead-1', leadName: 'Ana Lee', since: '2026-10-26T10:16:00Z', reason: 'SLA_BREACHED' }] },
      escalated:      { total: 0, items: [] },
    })
    for (const f of [review.listAwaitingReview, review.listSlaBreachedUncontacted, review.listEscalatedUncontacted]) {
      expect(f).toHaveBeenCalledWith('org-a', 5)
    }
  })
})
