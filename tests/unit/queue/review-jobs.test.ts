import { describe, it, expect, vi, beforeEach } from 'vitest'

const review = vi.hoisted(() => ({ getPlayForReview: vi.fn(), markPlayResumed: vi.fn(), markPlayEscalated: vi.fn() }))
const events = vi.hoisted(() => ({ writeEvent: vi.fn() }))
vi.mock('../../../src/repositories/play-review.repository.js', () => review)
vi.mock('../../../src/events/event-log.js', () => events)
vi.mock('../../../src/evidence/context-builder.js', () => ({
  buildDecisionSnapshot: vi.fn(async (p: any) => ({ lead: { id: p.leadId }, company: null, policies: [], ownerWorkloads: {}, evidenceIds: [], agentName: p.agentName, agentVersion: p.agentVersion, promptVersion: null, modelName: null })),
}))

const { processResumePlay, resumeJobId } = await import('../../../src/queue/jobs/resume-play.js')
const { processEscalation } = await import('../../../src/queue/jobs/escalate-play.js')

const DECIDED = '2026-10-26T10:05:00.000Z'
const decision = { decision: 'approved', kind: 'routing', owner_id: '005REP', owner_name: 'Alice', note: null, actor_user_id: 'user-1', decided_at: DECIDED }
const play = (over = {}) => ({
  id: 'play-1', lead_id: 'lead-1', status: 'paused', workflow_run_id: 'run-1', sla_breached: false,
  review_kind: 'routing', review_context: { reason_codes: [] }, review_decision: decision,
  review_decided_at: '2026-10-26T10:05:00+00:00', ...over,   // Postgres format differs from the job's ISO string
})
const job = { playId: 'play-1', organizationId: 'org-a', decidedAt: DECIDED }
const resume = vi.fn()
const types = () => events.writeEvent.mock.calls.map(c => c[0].eventType)

beforeEach(() => {
  for (const m of [...Object.values(review), ...Object.values(events)]) m.mockReset()
  resume.mockReset().mockResolvedValue({ status: 'completed', resumed: 'decision' })
  review.markPlayResumed.mockResolvedValue(true)
})

describe('processResumePlay', () => {
  it('marks the play running, writes play_resumed once, resumes with the stored decision', async () => {
    review.getPlayForReview.mockResolvedValue(play())
    expect(await processResumePlay(job, { resume })).toEqual({ outcome: 'resumed', status: 'completed', resumed: 'decision' })
    expect(review.getPlayForReview).toHaveBeenCalledWith('org-a', 'play-1')
    expect(review.markPlayResumed).toHaveBeenCalledWith('org-a', 'play-1', '2026-10-26T10:05:00+00:00')
    expect(types()).toEqual(['play_resumed'])
    expect(events.writeEvent.mock.calls[0][0]).toMatchObject({ workflowRunId: 'run-1', policyDecision: { decision: 'approved' } })
    expect(resume).toHaveBeenCalledWith('run-1', decision)
  })

  it('retry after the play is already running: no second play_resumed, still continues the graph', async () => {
    review.getPlayForReview.mockResolvedValue(play({ status: 'running' }))
    await processResumePlay(job, { resume })
    expect(review.markPlayResumed).not.toHaveBeenCalled()
    expect(types()).toEqual([])
    expect(resume).toHaveBeenCalledOnce()
  })

  it('a stale job (decision on record is from a different review) does nothing', async () => {
    review.getPlayForReview.mockResolvedValue(play({ review_decided_at: '2026-10-26T11:00:00Z' }))
    expect(await processResumePlay(job, { resume })).toEqual({ outcome: 'stale' })
    expect(resume).not.toHaveBeenCalled()
    review.getPlayForReview.mockResolvedValue(play({ review_decision: null, review_decided_at: null }))
    expect(await processResumePlay(job, { resume })).toEqual({ outcome: 'stale' })
  })

  it('finished or missing plays are left alone', async () => {
    review.getPlayForReview.mockResolvedValue(play({ status: 'nurture' }))
    expect(await processResumePlay(job, { resume })).toEqual({ outcome: 'already_finished' })
    review.getPlayForReview.mockResolvedValue(null)
    expect(await processResumePlay(job, { resume })).toEqual({ outcome: 'not_found' })
    expect(resume).not.toHaveBeenCalled()
  })

  it('a failed resume writes action_execution_failed with the code and rethrows (BullMQ retries)', async () => {
    review.getPlayForReview.mockResolvedValue(play())
    resume.mockRejectedValue(Object.assign(new Error('SF down'), { code: 'SF_LEAD_ASSIGN_FAILED' }))
    await expect(processResumePlay(job, { resume })).rejects.toThrow('SF down')
    expect(events.writeEvent.mock.calls.at(-1)![0]).toMatchObject({ eventType: 'action_execution_failed', errorCode: 'SF_LEAD_ASSIGN_FAILED' })
  })

  it('job ids are stable per decision, so a double submit enqueues once', () => {
    expect(resumeJobId('play-1', DECIDED)).toBe(resumeJobId('play-1', '2026-10-26T10:05:00+00:00'))
    expect(resumeJobId('play-1', DECIDED)).not.toContain(':')
  })
})

describe('processEscalation', () => {
  it('writes escalation_sent with channel in_app and stamps the play', async () => {
    review.getPlayForReview.mockResolvedValue(play({ status: 'running', sla_breached: true }))
    expect(await processEscalation({ playId: 'play-1', organizationId: 'org-a', reason: 'SLA_BREACHED' })).toBe('sent')
    expect(review.markPlayEscalated).toHaveBeenCalledWith('org-a', 'play-1', 'SLA_BREACHED')
    expect(events.writeEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'escalation_sent', eventStatus: 'success', actorType: 'sla_timer', workflowRunId: 'run-1',
      policyDecision: { channel: 'in_app', reason: 'SLA_BREACHED' },
      decisionSnapshot: expect.objectContaining({ agentName: 'escalate-worker', lead: { id: 'lead-1' } }),
    }))
  })

  it('uses the reason from the job (e.g. outreach not set up)', async () => {
    review.getPlayForReview.mockResolvedValue(play({ status: 'running' }))
    await processEscalation({ playId: 'play-1', organizationId: 'org-a', reason: 'OUTREACH_TIER_NOT_SET' })
    expect(events.writeEvent.mock.calls[0][0]).toMatchObject({ actorType: 'system', policyDecision: { channel: 'in_app', reason: 'OUTREACH_TIER_NOT_SET' } })
  })

  it('unknown play → no event', async () => {
    review.getPlayForReview.mockResolvedValue(null)
    expect(await processEscalation({ playId: 'x', organizationId: 'org-a' })).toBe('not_found')
    expect(events.writeEvent).not.toHaveBeenCalled()
  })
})
