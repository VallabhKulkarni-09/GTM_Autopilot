'use client'

import { useState } from 'react'
import type { DescribedEvent, Tone } from '@/lib/describe-event'

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--apple-gray2)',
  info:    'var(--apple-blue)',
  success: 'var(--apple-green)',
  warning: 'var(--apple-orange)',
  danger:  'var(--apple-red)',
}

const OUTCOME: Record<DescribedEvent['outcome'], { label: string; color: string } | null> = {
  success: null, // the title already says what happened
  failed:  { label: 'Failed', color: 'var(--apple-red)' },
  skipped: { label: 'Skipped', color: 'var(--apple-text-tertiary)' },
}

function gap(a: string, b: string): string {
  const d = Math.abs(new Date(b).getTime() - new Date(a).getTime())
  if (d < 1000) return 'under 1 s'
  if (d < 60000) return `${Math.round(d / 1000)} s`
  if (d < 3600000) return `${Math.round(d / 60000)} min`
  return `${Math.round(d / 3600000)} h`
}

/** "What happened" card. Plain language by default; "Developer details" reveals the raw facts. */
export function Timeline({ events, emptyText }: { events: DescribedEvent[]; emptyText: string }) {
  const [dev, setDev] = useState(false)

  return (
    <section className="apple-card flex-1 min-w-0" aria-labelledby="timeline-heading">
      <div className="px-5 py-4 border-b flex items-center justify-between gap-3" style={{ borderColor: 'var(--apple-separator)' }}>
        <div className="flex items-baseline gap-2">
          <h2 id="timeline-heading" className="text-[14px] font-semibold">What happened</h2>
          <span className="text-[12px]" style={{ color: 'var(--apple-text-tertiary)' }}>
            {events.length} {events.length === 1 ? 'step' : 'steps'}
          </span>
        </div>
        {events.length > 0 && (
          <button type="button" aria-pressed={dev} onClick={() => setDev(v => !v)}
            className="inline-flex items-center gap-2 h-8 px-3 rounded-[7px] border bg-white text-[12px] font-medium hover:bg-[color:var(--surface-subtle)]"
            style={{ borderColor: 'var(--border-strong)' }}>
            <span className="relative inline-block w-[26px] h-[15px] rounded-full transition-colors" aria-hidden="true"
              style={{ background: dev ? 'var(--ink)' : 'var(--apple-gray4)' }}>
              <span className="absolute top-[2px] w-[11px] h-[11px] rounded-full bg-white transition-[left]" style={{ left: dev ? 13 : 2 }} />
            </span>
            Developer details
          </button>
        )}
      </div>

      {events.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px]" style={{ color: 'var(--apple-text-tertiary)' }}>{emptyText}</p>
      ) : (
        <ol className="px-5 py-4" aria-label="Timeline">
          {events.map((ev, idx) => {
            const last = idx === events.length - 1
            const prev = idx > 0 ? events[idx - 1].at : null
            const outcome = OUTCOME[ev.outcome]
            return (
              <li key={ev.id} className="relative grid grid-cols-[16px_1fr_auto] gap-x-3 pb-5 last:pb-0">
                {!last && <span className="absolute left-[7.5px] top-[18px] bottom-0 w-px" style={{ background: 'var(--apple-separator)' }} aria-hidden="true" />}
                <span className="mt-[5px] w-[9px] h-[9px] ml-[3.5px] rounded-full"
                  style={{ background: TONE_COLOR[ev.tone], boxShadow: '0 0 0 3px #FFFFFF' }} aria-hidden="true" />

                <div className="min-w-0">
                  <div className="text-[13px] font-medium">
                    {ev.title}
                    {outcome && <span className="ml-2 text-[11px] font-medium" style={{ color: outcome.color }}>{outcome.label}</span>}
                  </div>
                  {ev.detail && <p className="text-[12px] mt-0.5" style={{ color: 'var(--apple-text-secondary)' }}>{ev.detail}</p>}
                  <div className="text-[12px] mt-0.5" style={{ color: 'var(--apple-text-tertiary)' }}>{ev.actor}</div>

                  {ev.reasons.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5 mt-2" aria-label="Reasons">
                      {ev.reasons.map((r, i) => (
                        <li key={`${r}-${i}`} className="px-1.5 py-[3px] rounded-[5px] border text-[11px]"
                          style={{ borderColor: 'var(--apple-separator)', background: 'var(--surface-subtle)', color: 'var(--apple-text-secondary)' }}>
                          {r}
                        </li>
                      ))}
                    </ul>
                  )}

                  {dev && (
                    <dl aria-label="Developer details" className="mt-2 rounded-[6px] border px-2.5 py-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[11px]"
                      style={{ borderColor: 'var(--apple-separator)', background: 'var(--surface-subtle)' }}>
                      {ev.developer.map(f => (
                        <div key={f.label} className="contents">
                          <dt style={{ color: 'var(--apple-text-tertiary)' }}>{f.label}</dt>
                          <dd className="font-mono break-all" style={{ color: 'var(--apple-text-secondary)' }}>{f.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>

                <div className="text-right">
                  <time className="text-[12px] tabular-nums" dateTime={ev.at} style={{ color: 'var(--apple-text-secondary)' }} suppressHydrationWarning>
                    {new Date(ev.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </time>
                  {prev && <div className="text-[11px] tabular-nums" style={{ color: 'var(--apple-text-tertiary)' }}>+{gap(prev, ev.at)}</div>}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
