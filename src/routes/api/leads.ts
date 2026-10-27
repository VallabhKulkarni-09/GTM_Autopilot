/**
 * leads.ts — GET /api/leads, GET /api/leads/:id, GET /api/leads/:id/timeline
 * All routes require tenantContextMiddleware (applied at app.ts level).
 *
 * Response shapes are aligned to dashboard expectations:
 *   GET /api/leads       → { data: LeadSummary[], page, limit, total }
 *   GET /api/leads/:id   → { lead: LeadDetail, currentPlay: PlayState | null }
 *   GET /api/leads/:id/timeline → TimelineEventDto[]  (array; trimmed, see timeline-dto.ts)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { toTimelineEventDto } from './timeline-dto.js'
import { getDb } from '../../db/client.js'
import { getLeadTimeline } from '../../repositories/event-log.repository.js'

// ── Response type helpers ──────────────────────────────────────────────────────

function formatLeadSummary(row: any, play: any = null) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email
  const firstTouchMs = play?.first_touch_at && play?.first_touch_deadline
    ? new Date(play.first_touch_at).getTime() -
      (new Date(play.first_touch_deadline).getTime() - 15 * 60_000)
    : null

  return {
    id:                  row.id,
    email:               row.email,
    name,
    title:               row.title ?? null,
    stage:               row.stage,
    source:              row.source,
    formSubmittedAt:     row.form_submitted_at,
    timeToFirstTouchMin: firstTouchMs !== null ? Math.round(firstTouchMs / 60_000) : null,
    slaBreached:         play?.sla_breached ?? false,
    isTest:              row.is_test === true,
    createdAt:           row.created_at,
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

export async function leadRoutes(app: FastifyInstance) {
  // ── GET /api/leads ──────────────────────────────────────────────────────────
  app.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:  { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            stage: {
              type: 'string',
              enum: ['new', 'routing', 'in_sequence', 'meeting_booked', 'nurture', 'lost'],
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { organizationId } = request.tenantContext
      const { page = 1, limit = 50, stage } = request.query as any
      const db = getDb()

      let leadsQuery = db
        .from('leads')
        .select(
          'id, email, first_name, last_name, title, stage, form_submitted_at, source, is_test, created_at',
          { count: 'exact' }
        )
        .eq('organization_id', organizationId)
        .is('removed_at', null)
        .order('form_submitted_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1)

      if (stage) leadsQuery = (leadsQuery as any).eq('stage', stage)

      const { data: leads, count, error } = await (leadsQuery as any)
      if (error) {
        return reply.status(500).send({
          error: 'QUERY_FAILED',
          message: 'Failed to list leads',
          requestId: request.id,
        })
      }

      // Bulk-fetch latest play instance per lead for SLA/timing data
      const leadIds = (leads ?? []).map((l: any) => l.id)
      let playsByLeadId: Record<string, any> = {}

      if (leadIds.length > 0) {
        const { data: plays } = await db
          .from('play_instance')
          .select('lead_id, sla_breached, first_touch_at, first_touch_deadline, status')
          .eq('organization_id', organizationId)
          .in('lead_id', leadIds)
          .order('created_at', { ascending: false })

        // Keep only the most recent play per lead
        for (const p of plays ?? []) {
          if (!playsByLeadId[p.lead_id]) playsByLeadId[p.lead_id] = p
        }
      }

      const data = (leads ?? []).map((l: any) =>
        formatLeadSummary(l, playsByLeadId[l.id] ?? null)
      )

      return reply.send({ data, page, limit, total: count ?? 0 })
    }
  )

  // ── GET /api/leads/:id ──────────────────────────────────────────────────────
  app.get(
    '/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { organizationId } = request.tenantContext
      const { id } = request.params as { id: string }
      const db = getDb()

      const { data: rawRow, error } = await db
        .from('leads')
        .select(
          'id, email, first_name, last_name, title, stage, phone, ' +
          'form_submitted_at, source, is_duplicate, is_icp_fit, icp_score, icp_tier, is_test, created_at'
        )
        .eq('organization_id', organizationId)
        .eq('id', id)
        .is('removed_at', null)
        .single()
      const row = rawRow as any

      // Cross-tenant: return 404, never 403 — never confirm resource exists in another org
      if (error || !row) {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Lead not found',
          requestId: request.id,
        })
      }

      // Attach current play instance state — includes outcome tracking columns (migration 018)
      const { data: play } = await db
        .from('play_instance')
        .select(
          'id, status, current_step, sla_breached, first_touch_at, first_touch_deadline, ' +
          'workflow_run_id, outcome_status, outcome_detected_at, late_meeting_flag, ' +
          'meetings_count_in_window, attribution_window_days'
        )
        .eq('organization_id', organizationId)
        .eq('lead_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      const lead = {
        id:              row.id,
        email:           row.email,
        name:            [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email,
        firstName:       row.first_name,
        lastName:        row.last_name,
        title:           row.title ?? null,
        phone:           row.phone ?? null,
        stage:           row.stage,
        source:          row.source,
        formSubmittedAt: row.form_submitted_at,
        isDuplicate:     row.is_duplicate,
        isIcpFit:        row.is_icp_fit ?? null,
        icpScore:        row.icp_score ?? null,
        icpTier:         row.icp_tier ?? null,
        isTest:          row.is_test === true,
        createdAt:       row.created_at,
      }

      return reply.send({ lead, currentPlay: play ?? null })
    }
  )

  // ── GET /api/leads/:id/timeline ─────────────────────────────────────────────
  // Returns an array directly — dashboard calls [...timeline].sort()
  app.get(
    '/:id/timeline',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { organizationId } = request.tenantContext
      const { id } = request.params as { id: string }

      // Verify the lead belongs to this org — 404 if not (never 403, cross-tenant)
      const { data: lead, error: leadErr } = await getDb()
        .from('leads')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('id', id)
        .is('removed_at', null)
        .single()

      if (leadErr || !lead) {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Lead not found',
          requestId: request.id,
        })
      }

      // Return the array directly — dashboard spreads it: [...timeline].sort()
      const timeline = await getLeadTimeline(organizationId, id)
      return reply.send(timeline.map(row => toTimelineEventDto(row as never)))
    }
  )
}
