import Link from 'next/link'
import { apiFetch } from '@/lib/api'
import { getServerToken } from '@/lib/auth'
import { PaginatedLeads } from '@/types/api'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { LeadsFilter } from './leads-filter'

export const dynamic = 'force-dynamic'

// Stage labels. Colour is a small dot; text stays neutral so the table reads calmly.
const STAGES: Record<string, { label: string; dot: string }> = {
  new:            { label: 'New',            dot: 'var(--apple-gray2)' },
  enriching:      { label: 'Enriching',      dot: 'var(--apple-blue)' },
  routing:        { label: 'Routing',        dot: 'var(--apple-blue)' },
  in_sequence:    { label: 'In sequence',    dot: 'var(--apple-purple)' },
  meeting_booked: { label: 'Meeting booked', dot: 'var(--apple-green)' },
  nurture:        { label: 'Nurture',        dot: 'var(--apple-orange)' },
  lost:           { label: 'Lost',           dot: 'var(--apple-red)' },
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(n => n[0] ?? '').join('').toUpperCase()
}

function FirstContact({ minutes }: { minutes: number | null }) {
  if (minutes === null) return <span style={{ color: 'var(--apple-text-tertiary)' }}>Not yet</span>
  const late = minutes > 15
  return (
    <span className="tabular-nums" style={{ color: late ? 'var(--apple-red)' : 'var(--apple-text-primary)' }}>
      {minutes} min{late && <span className="sr-only"> (late)</span>}
    </span>
  )
}

function pageHref(page: number, stage?: string, dateRange?: string): string {
  const qs = new URLSearchParams({ page: String(page) })
  if (stage) qs.set('stage', stage)
  if (dateRange) qs.set('dateRange', dateRange)
  return `/leads?${qs.toString()}`
}

const COLS = 'grid grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)_16px] gap-4'

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params    = await searchParams
  const page      = Number(params.page || '1')
  const stage     = typeof params.stage     === 'string' ? params.stage     : undefined
  const dateRange = typeof params.dateRange === 'string' ? params.dateRange : undefined

  let data: PaginatedLeads | null = null
  try {
    const token = await getServerToken()
    const qs = new URLSearchParams({ page: page.toString(), limit: '50' })
    if (stage)     qs.set('stage', stage)
    if (dateRange) qs.set('dateRange', dateRange)
    const res = await apiFetch(`/api/leads?${qs.toString()}`, token)
    if (res.ok) data = await res.json()
  } catch {
    data = null
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Leads</h1>
        <p className="text-[13px] mt-1" style={{ color: 'var(--apple-text-tertiary)' }}>
          {data ? `${data.total.toLocaleString()} ${data.total === 1 ? 'lead' : 'leads'}` : 'Inbound form submissions and what happened to each one'}
        </p>
      </div>

      <LeadsFilter />

      {!data ? (
        <div role="alert" className="apple-card p-5">
          <div className="text-[14px] font-semibold">Leads could not be loaded</div>
          <div className="text-[13px] mt-1" style={{ color: 'var(--apple-text-secondary)' }}>
            The API did not respond. Check that the API service is running, then refresh.
          </div>
        </div>
      ) : (
        <>
          <div className="apple-card overflow-hidden">
            <div className={`${COLS} px-5 py-2.5 border-b`} style={{ background: 'var(--surface-subtle)', borderColor: 'var(--apple-separator)' }}>
              {['Lead', 'Title', 'Stage', 'First contact', 'Owner'].map(h => <div key={h} className="label-caps">{h}</div>)}
              <div aria-hidden="true" />
            </div>

            {data.data.length === 0 ? (
              <div className="py-14 text-center">
                <div className="text-[13px] font-medium" style={{ color: 'var(--apple-text-secondary)' }}>
                  {stage || dateRange ? 'No leads match these filters' : 'No leads yet'}
                </div>
                <div className="text-[12px] mt-1" style={{ color: 'var(--apple-text-tertiary)' }}>
                  {stage || dateRange ? 'Try a different stage or date range.' : 'New HubSpot form submissions will appear here.'}
                </div>
              </div>
            ) : (
              data.data.map(lead => {
                const st = STAGES[lead.stage] ?? { label: lead.stage, dot: 'var(--apple-gray2)' }
                const email = (lead as { email?: string }).email
                const name = lead.name || email || 'Unnamed lead'
                const company = lead.company || email?.split('@')[1] || ''
                return (
                  <Link key={lead.id} href={`/leads/${lead.id}`}
                    className={`${COLS} px-5 py-3 items-center finder-row group outline-none focus-visible:bg-[color:var(--surface-subtle)]`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0"
                        style={{ background: 'var(--apple-gray6)', color: 'var(--apple-text-secondary)', boxShadow: 'inset 0 0 0 1px var(--apple-separator)' }}
                        aria-hidden="true">
                        {initials(name)}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium truncate">
                          {name}
                          {lead.isTest && <span className="ml-1.5 inline-flex items-center h-[18px] px-1 rounded-[4px] border text-[10px] font-medium align-middle"
                            style={{ borderColor: 'var(--border-strong)', color: 'var(--apple-text-secondary)' }}>Test</span>}
                        </div>
                        {company && <div className="text-[12px] truncate" style={{ color: 'var(--apple-text-tertiary)' }}>{company}</div>}
                      </div>
                    </div>
                    <div className="text-[13px] truncate" style={{ color: 'var(--apple-text-secondary)' }}>
                      {lead.title || <span style={{ color: 'var(--apple-text-tertiary)' }}>Not provided</span>}
                    </div>
                    <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--apple-text-secondary)' }}>
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: st.dot }} aria-hidden="true" />
                      {st.label}
                    </div>
                    <div className="text-[13px]"><FirstContact minutes={lead.timeToFirstTouchMin} /></div>
                    <div className="text-[13px] truncate" style={{ color: lead.assignedTo ? 'var(--apple-text-secondary)' : 'var(--apple-text-tertiary)' }}>
                      {lead.assignedTo ?? 'Unassigned'}
                    </div>
                    <ChevronRight size={14} aria-hidden="true" className="opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ color: 'var(--apple-text-tertiary)' }} />
                  </Link>
                )
              })
            )}
          </div>

          {data.total > 0 && (
            <nav className="flex items-center justify-between" aria-label="Pagination">
              <div className="text-[12px] tabular-nums" style={{ color: 'var(--apple-text-tertiary)' }}>
                {Math.min((page - 1) * data.limit + 1, data.total)} to {Math.min(page * data.limit, data.total)} of {data.total}
              </div>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link href={pageHref(page - 1, stage, dateRange)}
                    className="inline-flex items-center gap-1 h-8 pl-2 pr-3 rounded-[7px] border bg-white text-[12px] font-medium hover:bg-[color:var(--surface-subtle)]"
                    style={{ borderColor: 'var(--border-strong)' }}>
                    <ChevronLeft size={14} aria-hidden="true" /> Previous
                  </Link>
                )}
                {page * data.limit < data.total && (
                  <Link href={pageHref(page + 1, stage, dateRange)}
                    className="inline-flex items-center gap-1 h-8 pl-3 pr-2 rounded-[7px] border bg-white text-[12px] font-medium hover:bg-[color:var(--surface-subtle)]"
                    style={{ borderColor: 'var(--border-strong)' }}>
                    Next <ChevronRight size={14} aria-hidden="true" />
                  </Link>
                )}
              </div>
            </nav>
          )}
        </>
      )}
    </div>
  )
}
