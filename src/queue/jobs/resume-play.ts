/**
 * resume-play.ts — applies a human review decision to a paused play.
 *
 * Enqueued by POST /api/plays/:id/approve|reject with jobId resume-<playId>-<decidedAtMs>,
 * so a double click or a retried request enqueues once. Safe to run more than once:
 *   - the decision is read from play_instance (source of truth), and must match the job's
 *     decidedAt, so a stale job can never apply an old decision to a newer review
 *   - paused → running + play_resumed happen once (conditional update)
 *   - resumeInboundLeadPlay resumes, continues after a crash, or does nothing if finished
 */

import { writeEvent } from '../../events/event-log.js'
import { buildDecisionSnapshot } from '../../evidence/context-builder.js'
import { getPlayForReview, markPlayResumed } from '../../repositories/play-review.repository.js'
import type { ReviewDecision } from '../../domain/db-types.js'
import type { DecisionSnapshot } from '../../actions/types.js'

export type ResumePlayJob = { playId: string; organizationId: string; decidedAt: string }

export const RESUME_AGENT = { name: 'resume-play-worker', version: '1.0.0' } as const

type Deps = {
  resume: (workflowRunId: string, decision: ReviewDecision) => Promise<{ status: string; resumed: string }>
}

export type ResumeOutcome =
  | { outcome: 'not_found' | 'stale' | 'already_finished' }
  | { outcome: 'resumed'; status: string; resumed: string }

const sameInstant = (a: string | null, b: string | null) =>
  !!a && !!b && new Date(a).getTime() === new Date(b).getTime()

export function resumeJobId(playId: string, decidedAt: string): string {
  return `resume-${playId}-${new Date(decidedAt).getTime()}`
}

export async function processResumePlay(job: ResumePlayJob, deps: Deps): Promise<ResumeOutcome> {
  const { playId, organizationId } = job
  const play = await getPlayForReview(organizationId, playId)
  if (!play) {
    console.error(`[resume-play] Play ${playId} not found in org ${organizationId}`)
    return { outcome: 'not_found' }
  }
  if (!play.review_decision || !sameInstant(play.review_decided_at, job.decidedAt)) {
    console.warn(`[resume-play] Stale job for play ${playId}: decision on record is ${play.review_decided_at ?? 'none'}, job has ${job.decidedAt}`)
    return { outcome: 'stale' }
  }
  if (play.status !== 'paused' && play.status !== 'running') {
    return { outcome: 'already_finished' }
  }

  const decision = play.review_decision
  const snapshot: DecisionSnapshot = await buildDecisionSnapshot({
    organizationId,
    leadId:        play.lead_id,
    workflowRunId: play.workflow_run_id ?? playId,
    agentName:     RESUME_AGENT.name,
    agentVersion:  RESUME_AGENT.version,
  })
  snapshot.humanReviewContext = {
    actorUserId:         decision.actor_user_id,
    decision:            decision.decision,
    playStateAtDecision: { status: play.status, review_kind: play.review_kind, review_context: play.review_context },
  }
  const base = {
    organizationId,
    workflowRunId:  play.workflow_run_id ?? playId,
    playInstanceId: playId,
    leadId:         play.lead_id,
    decisionSnapshot: snapshot,
  }

  if (!play.workflow_run_id) {
    await writeEvent({ ...base, eventType: 'action_execution_failed', actorType: 'system', eventStatus: 'failed',
      errorCode: 'CHECKPOINT_NOT_FOUND', errorMessage: 'This play has no workflow run to resume.' })
    throw Object.assign(new Error('CHECKPOINT_NOT_FOUND: play has no workflow_run_id'), { code: 'CHECKPOINT_NOT_FOUND' })
  }

  if (play.status === 'paused' && play.review_decided_at && await markPlayResumed(organizationId, playId, play.review_decided_at)) {
    await writeEvent({
      ...base,
      eventType:      'play_resumed',
      actorType:      'system',
      actorId:        RESUME_AGENT.name,
      eventStatus:    'success',
      idempotencyKey: `${organizationId}:${play.workflow_run_id}:play_resumed:${new Date(play.review_decided_at).getTime()}`,
      policyDecision: { decision: decision.decision, review_kind: decision.kind, decided_by: decision.actor_user_id },
    })
  }

  try {
    const result = await deps.resume(play.workflow_run_id, decision)
    return { outcome: 'resumed', ...result }
  } catch (err: any) {
    await writeEvent({ ...base, eventType: 'action_execution_failed', actorType: 'system', eventStatus: 'failed',
      errorCode: err?.code ?? 'RESUME_FAILED', errorMessage: err?.message ?? String(err), errorRaw: err?.raw })
    throw err
  }
}
