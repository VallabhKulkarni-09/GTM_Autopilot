'use client'

import { useRouter, useSearchParams } from 'next/navigation'

const STAGE_OPTIONS = [
  { value: 'all',            label: 'All' },
  { value: 'new',            label: 'New' },
  { value: 'routing',        label: 'Routing' },
  { value: 'in_sequence',    label: 'In sequence' },
  { value: 'meeting_booked', label: 'Meeting booked' },
  { value: 'nurture',        label: 'Nurture' },
  { value: 'lost',           label: 'Lost' },
]

const DATE_OPTIONS = [
  { value: 'all', label: 'All time' },
  { value: '7d',  label: '7 days' },
  { value: '30d', label: '30 days' },
]

/** Segmented control: one bordered group, the active option raised on a white surface. */
function Segmented({ label, options, value, onChange }: {
  label: string
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex items-center p-0.5 rounded-[8px] border"
      style={{ background: 'var(--apple-gray6)', borderColor: 'var(--apple-separator)' }}>
      {options.map(opt => {
        const active = value === opt.value
        return (
          <button key={opt.value} type="button" aria-pressed={active} onClick={() => onChange(opt.value)}
            className={`h-7 px-2.5 rounded-[6px] text-[12px] font-medium transition-colors duration-100 ${active ? 'apple-pill-active' : 'hover:text-[color:var(--apple-text-primary)]'}`}
            style={active ? undefined : { color: 'var(--apple-text-secondary)' }}>
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export function LeadsFilter() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const stage     = searchParams.get('stage')     || 'all'
  const dateRange = searchParams.get('dateRange') || 'all'

  const update = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value === 'all') params.delete(key)
    else params.set(key, value)
    params.set('page', '1')
    router.push(`/leads?${params.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Segmented label="Stage" options={STAGE_OPTIONS} value={stage} onChange={v => update('stage', v)} />
      <Segmented label="Date range" options={DATE_OPTIONS} value={dateRange} onChange={v => update('dateRange', v)} />
    </div>
  )
}
