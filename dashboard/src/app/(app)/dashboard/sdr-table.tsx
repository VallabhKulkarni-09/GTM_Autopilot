'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { SpeedToLeadDistribution } from '@/types/api'

function initials(name: string): string {
  return name.split(' ').slice(0, 2).map(n => n[0] ?? '').join('').toUpperCase()
}

export function SdrTable({ stats }: { stats: SpeedToLeadDistribution['sdrStats'] }) {
  const [sortDesc, setSortDesc] = useState(true)
  const sorted = [...stats].sort((a, b) => (sortDesc ? b.under15MinPct - a.under15MinPct : a.under15MinPct - b.under15MinPct))

  if (stats.length === 0) {
    return (
      <div className="py-10 text-center rounded-[8px] border border-dashed" style={{ borderColor: 'var(--apple-separator)' }}>
        <div className="text-[13px] font-medium" style={{ color: 'var(--apple-text-secondary)' }}>No rep activity yet</div>
        <div className="text-[12px] mt-1" style={{ color: 'var(--apple-text-tertiary)' }}>
          This fills in once qualified leads are assigned to reps.
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-[8px] border" style={{ borderColor: 'var(--apple-separator)' }}>
      <table className="w-full text-[13px]">
        <caption className="sr-only">Response time by rep</caption>
        <thead style={{ background: 'var(--surface-subtle)' }}>
          <tr className="border-b" style={{ borderColor: 'var(--apple-separator)' }}>
            <th scope="col" className="label-caps text-left font-medium px-4 py-2.5">Rep</th>
            <th scope="col" className="label-caps text-left font-medium px-4 py-2.5">Median first contact</th>
            <th scope="col" className="text-left px-4 py-2.5" aria-sort={sortDesc ? 'descending' : 'ascending'}>
              <button type="button" onClick={() => setSortDesc(d => !d)}
                className="label-caps font-medium inline-flex items-center gap-1 hover:text-[color:var(--apple-text-primary)]">
                Within 15 min
                {sortDesc ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronUp size={12} aria-hidden="true" />}
              </button>
            </th>
            <th scope="col" className="label-caps text-right font-medium px-4 py-2.5">Completed</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(sdr => (
            <tr key={sdr.name} className="finder-row">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0"
                    style={{ background: 'var(--apple-gray6)', color: 'var(--apple-text-secondary)', boxShadow: 'inset 0 0 0 1px var(--apple-separator)' }}
                    aria-hidden="true">
                    {initials(sdr.name)}
                  </span>
                  <span className="font-medium">{sdr.name}</span>
                </div>
              </td>
              <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--apple-text-secondary)' }}>{sdr.medianFirstTouchMin} min</td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-28 h-1.5 rounded-[2px] overflow-hidden" style={{ background: 'var(--apple-gray6)' }}>
                    <div className="h-full rounded-[2px]" style={{ width: `${sdr.under15MinPct}%`, background: sdr.under15MinPct >= 50 ? 'var(--ink)' : 'var(--apple-orange)' }} />
                  </div>
                  <span className="tabular-nums font-medium w-10">{sdr.under15MinPct}%</span>
                </div>
              </td>
              <td className="px-4 py-3 text-right tabular-nums font-medium">{sdr.playsCompleted}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
