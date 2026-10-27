import Link from 'next/link'
import { apiFetch } from '@/lib/api'
import { getServerToken } from '@/lib/auth'
import type { ApiTimelineEvent, LeadDetail, LeadStage, PlayState } from '@/types/api'
import { describeTimeline, fitLabel, summarizeStatus, timelineFacts, type Tone } from '@/lib/describe-event'
import { ChevronLeft } from 'lucide-react'
import { Timeline } from './timeline'

export const dynamic = 'force-dynamic'

const STAGES: Record<LeadStage, { label: string; dot: string }> = {
  new:            { label: 'New',            dot: 'var(--apple-gray2)' },
  enriching:      { label: 'Enriching',      dot: 'var(--apple-blue)' },
  routing:        { label: 'Routing',        dot: 'var(--apple-blue)' },
  in_sequence:    { label: 'In sequence',    dot: 'var(--apple-purple)' },
  meeting_booked: { label: 'Meeting booked', dot: 'var(--apple-green)' },
  nurture:        { label: 'Nurture',        dot: 'var(--apple-orange)' },
  lost:           { label: 'Lost',           dot: 'var(--apple-red)' },
}

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--apple-gray2)',
  info:    'var(--apple-blue)',
  success: 'var(--apple-green)',
  warning: 'var(--apple-orange)',
  danger:  'var(--apple-red)',
}

function initials(n: string) { return n.split(/\s+/).slice(0, 2).map(x => x[0] ?? '').join('').toUpperCase() }

/** Timezone-free, so the server render matches what the reader expects. */
function relative(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now
  const m = Math.round(Math.abs(diff) / 60000)
  const span = m < 1 ? 'under a minute' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`
  return diff >= 0 ? `in ${span}` : `${span} ago`
}

function gap(a: string, b: string): string {
  const d = Math.abs(new Date(b).getTime() - new Date(a).getTime())
  if (d < 1000) return 'under 1 s'
  if (d < 60000) return `${Math.round(d / 1000)} s`
  if (d < 3600000) return `${Math.round(d / 60000)} min`
  return `${Math.round(d / 3600000)} h`
}

const muted = (text: string) => <span style={{ color: 'var(--apple-text-tertiary)' }}>{text}</span>

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 border-b last:border-b-0" style={{ borderColor: 'var(--apple-separator)' }}>
      <dt className="text-[12px]" style={{ color: 'var(--apple-text-tertiary)' }}>{label}</dt>
      <dd className="text-[13px] font-medium text-right tabular-nums">{children}</dd>
    </div>
  )
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let lead: LeadDetail | null = null
  let play: PlayState | null = null
  let raw: ApiTimelineEvent[] = []
  let status: 'ok' | 'not_found' | 'error' = 'ok'

  try {
    const token = await getServerToken()
    const [lr, tr] = await Promise.all([
      apiFetch(`/api/leads/${id}`, token),
      apiFetch(`/api/leads/${id}/timeline`, token),
    ])
    if (lr.status === 404) status = 'not_found'
    else if (!lr.ok || !tr.ok) status = 'error'
    else {
      const body = await lr.json() as { lead: LeadDetail; currentPlay: PlayState | null }
      lead = body.lead
      play = body.currentPlay
      raw = await tr.json() as ApiTimelineEvent[]
    }
  } catch {
    status = 'error'
  }

  const back = (
    <Link href="/leads" className="inline-flex items-center gap-1 text-[13px] w-fit hover:text-[color:var(--apple-text-primary)]"
      style={{ color: 'var(--apple-text-secondary)' }}>
      <ChevronLeft size={14} aria-hidden="true" /> Leads
    </Link>
  )

  if (!lead) {
    return (
      <div className="flex flex-col gap-5">
        {back}
        <div role="alert" className="apple-card p-5">
          <div className="text-[14px] font-semibold">{status === 'not_found' ? 'Lead not found' : 'This lead could not be loaded'}</div>
          <div className="text-[13px] mt-1" style={{ color: 'var(--apple-text-secondary)' }}>
            {status === 'not_found'
              ? 'It may have been removed, or it belongs to another workspace.'
              : 'The API did not respond. Check that the API service is running, then refresh.'}
          </div>
        </div>
      </div>
    )
  }

  const events = describeTimeline(raw)
  const facts = timelineFacts(raw)
  const summary = summarizeStatus(lead, play, facts, events.length, iso => relative(iso))
  const stage = STAGES[lead.stage] ?? { label: lead.stage, dot: 'var(--apple-gray2)' }
  const name = lead.name || lead.email || 'Unnamed lead'
  const fit = fitLabel(lead.icpTier)
  const minutesSinceSubmit = (Date.now() - new Date(lead.formSubmittedAt).getTime()) / 60000
  const emptyText = minutesSinceSubmit > 5
    ? 'Nothing has been recorded for this lead. If it was submitted more than a few minutes ago, check that the worker service is running.'
    : 'Nothing has happened yet. Steps appear here as soon as the form submission is processed.'

  return (
    <div className="flex flex-col gap-5">
      {back}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3.5 min-w-0">
          <span className="w-10 h-10 rounded-full flex items-center justify-center text-[13px] font-semibold flex-shrink-0"
            style={{ background: 'var(--apple-gray6)', color: 'var(--apple-text-secondary)', boxShadow: 'inset 0 0 0 1px var(--apple-separator)' }}
            aria-hidden="true">
            {initials(name)}
          </span>
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-[-0.015em] truncate">
              {name}
              {lead.isTest && <span className="ml-2 align-middle inline-flex items-center h-5 px-1.5 rounded-[5px] border text-[11px] font-medium"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--apple-text-secondary)' }}>Test lead</span>}
            </h1>
            <div className="text-[13px] truncate" style={{ color: 'var(--apple-text-secondary)' }}>
              {[lead.title, facts.company, lead.email].filter(Boolean).join(' · ') || 'No details provided'}
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[6px] border bg-white text-[12px] font-medium flex-shrink-0"
          style={{ borderColor: 'var(--apple-separator)', color: 'var(--apple-text-secondary)' }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: stage.dot }} aria-hidden="true" />
          {stage.label}
        </span>
      </div>

      {/* Status summary */}
      <section className="apple-card px-5 py-4 flex items-start gap-3" aria-labelledby="status-heading">
        <span className="mt-[6px] w-[9px] h-[9px] rounded-full flex-shrink-0" style={{ background: TONE_COLOR[summary.tone] }} aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="status-heading" className="sr-only">Where this lead is now</h2>
          <p className="text-[14px] font-semibold">{summary.headline}</p>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--apple-text-secondary)' }}>{summary.detail}</p>
          {play?.status === 'paused' && (
            <Link href="/approvals" className="inline-block mt-2 text-[13px] font-medium underline underline-offset-2">Open Approvals</Link>
          )}
        </div>
      </section>

      <div className="flex flex-col lg:flex-row gap-5 items-start">
        <Timeline events={events} emptyText={emptyText} />

        {/* Details */}
        <aside className="w-full lg:w-[280px] flex-shrink-0 flex flex-col gap-4">
          <section className="apple-card px-5 py-3" aria-labelledby="details-heading">
            <h2 id="details-heading" className="label-caps pt-1 pb-1">Details</h2>
            <dl>
              <Field label="Submitted">{relative(lead.formSubmittedAt)}</Field>
              <Field label="Fit">
                {fit
                  ? <>{fit}{lead.icpScore !== null && <span className="font-normal" style={{ color: 'var(--apple-text-tertiary)' }}> {lead.icpScore}/100</span>}</>
                  : muted('Not scored yet')}
              </Field>
              <Field label="Owner">{facts.owner ?? muted('Not assigned yet')}</Field>
              <Field label="Contact due">
                {!play?.first_touch_deadline
                  ? muted('No deadline yet')
                  : play.first_touch_at
                    ? muted('Contacted')
                    : <span style={{ color: play.sla_breached ? 'var(--apple-red)' : undefined }}>{relative(play.first_touch_deadline)}</span>}
              </Field>
              <Field label="First contact">{play?.first_touch_at ? relative(play.first_touch_at) : muted('Not yet')}</Field>
              <Field label="Problems">
                {facts.failures === 0 ? muted('None') : <span style={{ color: 'var(--apple-red)' }}>{facts.failures}</span>}
              </Field>
              {events.length >= 2 && <Field label="Processing time">{gap(events[0].at, events[events.length - 1].at)}</Field>}
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}
