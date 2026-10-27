import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { apiFetch, getMe } from '@/lib/api'
import { getServerToken } from '@/lib/auth'
import { SETUP_SKIPPED_COOKIE } from '@/lib/setup'
import { OverviewMetrics, SpeedToLeadDistribution } from '@/types/api'
import { SdrTable } from './sdr-table'
import { NeedsAttention, type Attention } from './needs-attention'

export const dynamic = 'force-dynamic'

// Response-time buckets. Solid tones: within target reads as ink, late as amber/red.
const BUCKETS: Record<string, { label: string; color: string }> = {
  under5:  { label: 'Under 5 min',  color: '#18181B' },
  under15: { label: '5 to 15 min',  color: '#52525B' },
  under30: { label: '15 to 30 min', color: '#C4790F' },
  under60: { label: '30 to 60 min', color: '#B54708' },
  over60:  { label: 'Over 1 hour',  color: '#B42318' },
}

function Metric({ label, value, sub, tone = 'default' }: {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'danger'
}) {
  const numeric = Number(String(value).replace('%', ''))
  return (
    <div className="p-5 min-w-0">
      <div className="text-[12px] font-medium" style={{ color: 'var(--apple-text-secondary)' }}>{label}</div>
      <div className="text-[26px] font-semibold tabular-nums leading-none tracking-[-0.02em] mt-2.5"
        style={{ color: tone === 'danger' && numeric > 0 ? 'var(--apple-red)' : 'var(--apple-text-primary)' }}>
        {value}
      </div>
      {sub && <div className="text-[12px] mt-2 truncate" style={{ color: 'var(--apple-text-tertiary)' }}>{sub}</div>}
    </div>
  )
}

function delta(n: number, unit = ''): string {
  if (n === 0) return `No change vs prior 30 days`
  return `${n > 0 ? '+' : ''}${n}${unit} vs prior 30 days`
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default async function DashboardPage() {
  // Overview is where sign-in lands: send an admin with unfinished setup to the wizard,
  // unless they chose "Skip for now" in this browser session.
  const meToken = await getServerToken()
  const me = await getMe(meToken)
  const skipped = (await cookies()).get(SETUP_SKIPPED_COOKIE)?.value === '1'
  if (me.role === 'admin' && me.workspace && !me.workspace.setupCompleted && !skipped) redirect('/setup')

  let overview: OverviewMetrics
  let distribution: SpeedToLeadDistribution
  let attention: Attention | null = null

  try {
    const token = meToken
    const [overviewRes, distRes, attentionRes] = await Promise.all([
      apiFetch('/api/metrics/overview', token),
      apiFetch('/api/metrics/speed-to-lead', token),
      apiFetch('/api/attention', token).catch(() => null),
    ])
    if (attentionRes?.ok) attention = await attentionRes.json()
    if (!overviewRes.ok || !distRes.ok) throw new Error('API error')
    overview = await overviewRes.json()
    distribution = await distRes.json()
  } catch (error: any) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]" style={{ color: 'var(--apple-text-primary)' }}>
          Overview
        </h1>
        <div role="alert" className="apple-card p-5">
          <div className="text-[14px] font-semibold">Metrics are unavailable</div>
          <div className="text-[13px] mt-1" style={{ color: 'var(--apple-text-secondary)' }}>
            The API did not respond ({error?.message ?? 'unknown error'}). Check that the API service is running, then refresh.
          </div>
        </div>
      </div>
    )
  }

  const cp = overview.currentPeriod
  const pp = overview.priorPeriod
  const qualifiedDelta = cp.totalQualified - pp.totalQualified
  const speedDelta     = cp.touchedUnder15MinPct - pp.touchedUnder15MinPct

  return (
    <div className="flex flex-col gap-6">

      {/* ── Page Header ──────────────────────────────────────────── */}
      <div>
        <h1
          className="text-[22px] font-semibold tracking-[-0.015em] leading-tight"
          style={{ color: 'var(--apple-text-primary)' }}
        >
          Overview
        </h1>
        <p className="text-[13px] mt-1" style={{ color: 'var(--apple-text-tertiary)' }}>
          Last 30 days
        </p>
      </div>

      <div className="apple-card grid grid-cols-2 lg:grid-cols-3 divide-x divide-y lg:divide-y-0 [&>*:nth-child(n+4)]:lg:border-t" style={{ borderColor: 'var(--apple-separator)' }}>
        <Metric label="Leads qualified" value={cp.totalQualified} sub={delta(qualifiedDelta)} />
        <Metric label="Contacted within 15 min" value={`${cp.touchedUnder15MinPct}%`} sub={delta(speedDelta, ' pts')} />
        <Metric label="Missed response deadline" value={cp.slaBreaches} sub="Leads not contacted in time" tone="danger" />
        <Metric label="In progress" value={cp.activePlays} sub="Leads still being worked" />
        <Metric label="Meeting rate"
          value={cp.meeting_rate === null || cp.meeting_rate === undefined ? 'No data' : `${cp.meeting_rate}%`}
          sub={cp.meeting_rate === null || cp.meeting_rate === undefined ? 'Shown after the first follow-up window closes' : 'Booked a meeting in Salesforce'} />
        <Metric label="Completed" value={cp.playsCompleted} sub="Finished every automated step" />
      </div>

      <NeedsAttention attention={attention} />

      {/* ── Speed-to-Lead Distribution ───────────────────────────── */}
      <div className="apple-card p-5">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-[14px] font-semibold" style={{ color: 'var(--apple-text-primary)' }}>
              Time to first contact
            </h2>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--apple-text-tertiary)' }}>
              {distribution.total} {distribution.total === 1 ? 'lead' : 'leads'} with a recorded first contact
            </p>
          </div>
          <div className="text-[12px]" style={{ color: 'var(--apple-text-tertiary)' }}>Target: 15 min</div>
        </div>

        {/* Bars or empty state */}
        {distribution.total === 0 ? (
          <div className="py-10 text-center rounded-[8px] border border-dashed" style={{ borderColor: 'var(--apple-separator)' }}>
            <div className="text-[13px] font-medium" style={{ color: 'var(--apple-text-secondary)' }}>No contact data yet</div>
            <div className="text-[12px] mt-1" style={{ color: 'var(--apple-text-tertiary)' }}>This fills in once reps start contacting routed leads.</div>
          </div>
        ) : (
          <div className="space-y-3">
            {Object.entries(distribution.buckets).map(([key, data]) => {
              const bucket = BUCKETS[key]
              return (
                <div key={key} className="flex items-center gap-4">
                  {/* Label */}
                  <div
                    className="w-24 text-[12px] font-medium flex-shrink-0"
                    style={{ color: 'var(--apple-text-secondary)' }}
                  >
                    {bucket.label}
                  </div>

                  {/* Track + filled bar */}
                  <div className="flex-1 h-1.5 rounded-[2px] overflow-hidden" style={{ background: 'var(--apple-gray6)' }}>
                    <div className="h-full rounded-[2px]"
                      style={{ width: `${Math.max(data.pct, data.count > 0 ? 2 : 0)}%`, background: bucket.color }} />
                  </div>

                  {/* Count + pct */}
                  <div
                    className="w-20 text-right text-[12px] font-semibold tabular-nums flex-shrink-0"
                    style={{ color: 'var(--apple-text-primary)' }}
                  >
                    {data.count}
                    <span className="font-normal ml-1" style={{ color: 'var(--apple-text-tertiary)' }}>
                      ({data.pct}%)
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Per-SDR Performance ──────────────────────────────────── */}
      <div className="apple-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[14px] font-semibold" style={{ color: 'var(--apple-text-primary)' }}>
              By rep
            </h2>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--apple-text-tertiary)' }}>
              Sorted by share of leads contacted on time
            </p>
          </div>
        </div>
        <SdrTable stats={distribution.sdrStats} />
      </div>

    </div>
  )
}
