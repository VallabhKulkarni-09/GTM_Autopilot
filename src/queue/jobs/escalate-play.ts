/**
 * escalate-play.ts — in-app escalation (v1 has no Slack).
 *
 * Enqueued by the SLA timer (response time missed) and by the executor when a lead
 * cannot be added to a sequence. Records escalation_sent with channel 'in_app' and
 * stamps play_instance.escalated_at/escalation_reason, which the "Needs attention"
 * card and GET /api/attention read.
 */

import { writeEvent } from '../../events/event-log.js'
import { buildDecisionSnapshot } from '../../evidence/context-builder.js'
import { getPlayForReview, markPlayEscalated } from '../../repositories/play-review.repository.js'

export type EscalatePlayJob = { playId: string; organizationId: string; reason?: string }

export const ESCALATE_AGENT = { name: 'escalate-worker', version: '2.0.0' } as const

export async function processEscalation(job: EscalatePlayJob): Promise<'sent' | 'not_found'> {
  const { playId, organizationId } = job
  const play = await getPlayForReview(organizationId, playId)
  if (!play) {
    console.error(`[escalate-worker] Play ${playId} not found for org ${organizationId}`)
    return 'not_found'
  }
  const reason = job.reason ?? (play.sla_breached ? 'SLA_BREACHED' : 'NEEDS_ATTENTION')

  await markPlayEscalated(organizationId, playId, reason)
  await writeEvent({
    organizationId,
    workflowRunId:  play.workflow_run_id ?? playId,
    playInstanceId: playId,
    leadId:         play.lead_id,
    eventType:      'escalation_sent',
    actorType:      play.sla_breached ? 'sla_timer' : 'system',
    actorId:        ESCALATE_AGENT.name,
    eventStatus:    'success',
    policyDecision: { channel: 'in_app', reason },
    decisionSnapshot: await buildDecisionSnapshot({
      organizationId,
      leadId:        play.lead_id,
      workflowRunId: play.workflow_run_id ?? playId,
      agentName:     ESCALATE_AGENT.name,
      agentVersion:  ESCALATE_AGENT.version,
    }),
  })
  return 'sent'
}
