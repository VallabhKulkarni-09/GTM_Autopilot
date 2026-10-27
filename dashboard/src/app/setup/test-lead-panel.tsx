'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { fitLabel } from '@/lib/describe-event'
import type { LeadStage, PlayStatus, TestLeadSummary } from '@/types/api'

const STAGE: Record<LeadStage, string> = {
  new: 'Received', enriching: 'Looking up the company', routing: 'Assigning a rep', in_sequence: 'In a sequence',
  meeting_booked: 'Meeting booked', nurture: 'Moved to nurture', lost: 'Lost',
}
const PLAY: Partial<Record<PlayStatus, string>> = {
  paused: 'Waiting for a person on Approvals', failed: 'Stopped after an error', duplicate: 'Duplicate',
}

const POLL_MS = 3000
const POLL_FOR_MS = 120_000

const field = 'w-full h-9 px-3 rounded-[7px] border bg-white text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--apple-blue)]'

function progress(l: TestLeadSummary): string {
  const parts = [PLAY[l.playStatus as PlayStatus] ?? STAGE[l.stage]]
  const fit = fitLabel(l.fit)
  if (fit) parts.push(fit)
  if (l.owner) parts.push(`Owner: ${l.owner}`)
  return parts.join(' · ')
}

/** Send a test lead, watch it arrive, remove test leads. */
export function TestLeadPanel({ defaultEmail, initialLeads }: { defaultEmail: string; initialLeads: TestLeadSummary[] }) {
  const router = useRouter()
  const [form, setForm] = useState({ email: defaultEmail, firstName: 'Test', lastName: 'Lead', title: '' })
  const [leads, setLeads] = useState(initialLeads)
  const [sending, setSending] = useState(false)
  const [waitingSince, setWaitingSince] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const pollUntil = useRef(0)

  async function refresh(): Promise<TestLeadSummary[] | null> {
    const res = await fetch('/api/test-lead', { cache: 'no-store' }).catch(() => null)
    if (!res?.ok) return null
    const data = await res.json() as { leads: TestLeadSummary[] }
    setLeads(data.leads)
    return data.leads
  }

  // While a send is in flight, poll until the lead shows up (or give up after 2 minutes).
  useEffect(() => {
    if (!waitingSince) return
    const timer = setInterval(async () => {
      const latest = await refresh()
      // Compare as times: Postgres returns "+00:00" where the API sent "Z".
      const sentAt = new Date(waitingSince).getTime()
      const arrived = latest?.some(l => new Date(l.submittedAt).getTime() >= sentAt)
      if (arrived) {
        setWaitingSince(null)
        setMessage({ kind: 'ok', text: 'Your test lead arrived. Open it to see each step.' })
        router.refresh()   // the checklist marks "Send a test lead" done
      } else if (Date.now() > pollUntil.current) {
        setWaitingSince(null)
        setMessage({ kind: 'error', text: 'The test lead has not arrived after 2 minutes. Check that the worker service is running, then refresh this page.' })
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [waitingSince, router])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setSending(true)
    setMessage(null)
    const body = Object.fromEntries(Object.entries({ ...form, email: form.email.trim() }).filter(([, v]) => v.trim() !== ''))
    const res = await fetch('/api/test-lead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null)
    const data = await res?.json().catch(() => ({}))
    setSending(false)
    if (res?.status !== 202) {
      setMessage({ kind: 'error', text: res?.status === 400 ? 'Please enter a valid email address.' : data?.message ?? 'The test lead could not be sent. Please try again.' })
      return
    }
    pollUntil.current = Date.now() + POLL_FOR_MS
    setWaitingSince(data.submittedAt)
  }

  async function remove() {
    setConfirmRemove(false)
    const res = await fetch('/api/test-lead', { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) {
      setMessage({ kind: 'error', text: 'Test leads could not be removed. Please try again.' })
      return
    }
    const { removed } = await res.json() as { removed: number }
    setLeads([])
    setMessage({ kind: 'ok', text: `Removed ${removed} test ${removed === 1 ? 'lead' : 'leads'}.` })
    router.refresh()
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <div className="mt-4 space-y-4">
      <form onSubmit={send} className="space-y-3" aria-label="Send a test lead">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label htmlFor="tl-email" className="text-[12px] font-medium block mb-1">Work email</label>
            <input id="tl-email" type="email" required value={form.email} onChange={set('email')} className={field}
              style={{ borderColor: 'var(--border-strong)' }} aria-describedby="tl-email-hint" />
            <p id="tl-email-hint" className="text-[12px] mt-1" style={{ color: 'var(--apple-text-tertiary)' }}>
              Use your own work address: the company is looked up from it, and any sequence emails go to it.
            </p>
          </div>
          <div>
            <label htmlFor="tl-first" className="text-[12px] font-medium block mb-1">First name</label>
            <input id="tl-first" value={form.firstName} onChange={set('firstName')} className={field} style={{ borderColor: 'var(--border-strong)' }} />
          </div>
          <div>
            <label htmlFor="tl-last" className="text-[12px] font-medium block mb-1">Last name</label>
            <input id="tl-last" value={form.lastName} onChange={set('lastName')} className={field} style={{ borderColor: 'var(--border-strong)' }} />
          </div>
          <div className="col-span-2">
            <label htmlFor="tl-title" className="text-[12px] font-medium block mb-1">Job title <span className="font-normal" style={{ color: 'var(--apple-text-tertiary)' }}>(optional)</span></label>
            <input id="tl-title" value={form.title} onChange={set('title')} placeholder="VP Sales" className={field} style={{ borderColor: 'var(--border-strong)' }} />
          </div>
        </div>

        <div className="rounded-[7px] border p-3 text-[12px] leading-relaxed" style={{ borderColor: 'var(--apple-separator)', background: 'var(--surface-subtle)', color: 'var(--apple-text-secondary)' }}>
          This runs the real process. If Salesforce is connected, a Lead and a call Task are created there.
          If a sequence is chosen for the lead&apos;s fit level, Apollo will start emailing this address.
          Test leads never count in your numbers.
        </div>

        <Button type="submit" disabled={sending || waitingSince !== null}>
          {sending ? 'Sending…' : waitingSince ? 'Waiting for it to arrive…' : 'Send test lead'}
        </Button>
      </form>

      <div aria-live="polite">
        {message && (
          <p role={message.kind === 'error' ? 'alert' : 'status'} className="text-[13px]"
            style={{ color: message.kind === 'error' ? 'var(--apple-red)' : 'var(--apple-green)' }}>
            {message.text}
          </p>
        )}
      </div>

      {leads.length > 0 && (
        <section aria-labelledby="tl-list-heading" className="space-y-2">
          <h3 id="tl-list-heading" className="label-caps">Your test leads</h3>
          <ul className="rounded-[7px] border divide-y" style={{ borderColor: 'var(--apple-separator)' }}>
            {leads.map(l => (
              <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-2.5" style={{ borderColor: 'var(--apple-separator)' }}>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium truncate">{l.name}</div>
                  <div className="text-[12px] truncate" style={{ color: 'var(--apple-text-secondary)' }}>{progress(l)}</div>
                </div>
                <Link href={`/leads/${l.id}`} className="text-[12px] font-medium underline underline-offset-2 flex-shrink-0">
                  See what happened<span className="sr-only"> to {l.name}</span>
                </Link>
              </li>
            ))}
          </ul>

          {confirmRemove ? (
            <div role="group" aria-label="Confirm removing test leads" className="rounded-[7px] border p-3 space-y-2" style={{ borderColor: 'var(--apple-separator)' }}>
              <p className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>
                Remove {leads.length} test {leads.length === 1 ? 'lead' : 'leads'}? They disappear from Leads and Approvals.
                Anything they created in Salesforce or Apollo stays there; delete it there if you need to.
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="destructive" onClick={remove}>Remove test leads</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmRemove(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirmRemove(true)}>Remove test leads…</Button>
          )}
        </section>
      )}
    </div>
  )
}
