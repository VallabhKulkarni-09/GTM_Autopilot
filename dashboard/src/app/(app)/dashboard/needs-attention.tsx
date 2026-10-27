import Link from 'next/link'
import { escalationReason, since } from '@/lib/review-labels'

type Item = { playId: string; leadId: string; leadName: string; since: string | null; reason: string | null }
type Group = { total: number; items: Item[] }
export type Attention = { awaitingReview: Group; slaBreached: Group; escalated: Group }

const GROUPS: { key: keyof Attention; title: string; describe: (i: Item) => string; href?: string }[] = [
  { key: 'awaitingReview', title: 'Waiting for a decision', describe: i => `Waiting ${since(i.since)}`, href: '/approvals' },
  { key: 'slaBreached',    title: 'Missed the response time', describe: i => `Missed ${since(i.since)} ago, not contacted yet` },
  { key: 'escalated',      title: 'Flagged for follow-up', describe: i => escalationReason(i.reason) },
]

/** Server component: the "Needs attention" card on the overview. */
export function NeedsAttention({ attention }: { attention: Attention | null }) {
  if (!attention) {
    return (
      <section className="apple-card p-5" aria-labelledby="attention-heading">
        <h2 id="attention-heading" className="text-[14px] font-semibold">Needs attention</h2>
        <p role="alert" className="text-[13px] mt-1" style={{ color: 'var(--apple-red)' }}>This list could not be loaded. Please refresh.</p>
      </section>
    )
  }
  const total = attention.awaitingReview.total + attention.slaBreached.total + attention.escalated.total
  return (
    <section className="apple-card p-5" aria-labelledby="attention-heading">
      <div className="flex items-baseline justify-between">
        <h2 id="attention-heading" className="text-[14px] font-semibold">Needs attention</h2>
        {total > 0 && <span className="text-[12px] tabular-nums" style={{ color: 'var(--apple-text-secondary)' }}>{total} {total === 1 ? 'lead' : 'leads'}</span>}
      </div>
      {total === 0 ? (
        <p className="text-[13px] mt-1" style={{ color: 'var(--apple-text-secondary)' }}>Nothing needs a person right now.</p>
      ) : (
        <div className="grid gap-5 mt-3 md:grid-cols-3">
          {GROUPS.map(g => {
            const group = attention[g.key]
            return (
              <div key={g.key} aria-labelledby={`attention-${g.key}`}>
                <h3 id={`attention-${g.key}`} className="text-[12px] font-medium flex items-baseline gap-2">
                  {g.title}
                  <span className="tabular-nums" style={{ color: group.total > 0 ? 'var(--apple-red)' : 'var(--apple-text-tertiary)' }}>{group.total}</span>
                </h3>
                {group.total === 0 ? (
                  <p className="text-[12px] mt-1" style={{ color: 'var(--apple-text-tertiary)' }}>None</p>
                ) : (
                  <ul className="mt-1 space-y-1.5">
                    {group.items.map(i => (
                      <li key={i.playId} className="text-[13px]">
                        <Link href={`/leads/${i.leadId}`} className="font-medium hover:underline">{i.leadName}</Link>
                        <span className="block text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>{g.describe(i)}</span>
                      </li>
                    ))}
                    {g.href && group.total > group.items.length && (
                      <li className="text-[12px]"><Link href={g.href} className="underline">See all {group.total}</Link></li>
                    )}
                  </ul>
                )}
                {g.href && group.total > 0 && group.total <= group.items.length && (
                  <Link href={g.href} className="text-[12px] underline mt-2 inline-block">Review on the Approvals page</Link>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
