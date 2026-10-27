'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/chip-input'

type TierSetting = { mode: 'sequence'; sequence_id: string; sequence_name: string } | { mode: 'manual' } | null
type Tier = 'tier_1' | 'tier_2'
type Config = { email_account: { id: string; email: string } | null; tiers: Record<Tier, TierSetting> }
export type OutreachPolicy = { id: string; version: number; config: Config }
type Sequence = { id: string; name: string; active: boolean }
type EmailAccount = { id: string; email: string; active: boolean; isDefault: boolean }
export type OutreachOptions =
  | { ok: true; sequences: Sequence[]; emailAccounts: EmailAccount[] }
  | { ok: false; notConnected: boolean; message: string }
type Message = { kind: 'ok' | 'error'; text: string } | null

const TIERS: { tier: Tier; label: string; hint: string }[] = [
  { tier: 'tier_1', label: 'Great fit leads', hint: 'Leads that score as a great fit on the Ideal customer page.' },
  { tier: 'tier_2', label: 'Good fit leads', hint: 'Leads that score as a good fit. "Not a fit" leads go to nurture and are never sequenced.' },
]
const MANUAL = '__manual__'
const UNSET = ''

const tierValue = (s: TierSetting) => (s === null ? UNSET : s.mode === 'manual' ? MANUAL : s.sequence_id)

export function OutreachEditor({ policy, options, isAdmin }: { policy: OutreachPolicy; options: OutreachOptions; isAdmin: boolean }) {
  const router = useRouter()
  const [config, setConfig] = useState<Config>(policy.config)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  const [issues, setIssues] = useState<string[]>([])

  const sequences = options.ok ? options.sequences : []
  const accounts = options.ok ? options.emailAccounts : []
  const canEdit = isAdmin && options.ok
  const dirty = JSON.stringify(config) !== JSON.stringify(policy.config)

  function setTier(tier: Tier, value: string) {
    const next: TierSetting = value === UNSET ? null
      : value === MANUAL ? { mode: 'manual' }
      : { mode: 'sequence', sequence_id: value, sequence_name: sequences.find(s => s.id === value)?.name ?? value }
    setConfig(c => ({ ...c, tiers: { ...c.tiers, [tier]: next } }))
  }

  function setAccount(id: string) {
    const a = accounts.find(x => x.id === id)
    setConfig(c => ({ ...c, email_account: a ? { id: a.id, email: a.email } : null }))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    setIssues([])
    const res = await fetch('/api/outreach', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, version: policy.version }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      setMessage({ kind: 'error', text: data.message ?? 'Something went wrong. Please try again.' })
      setIssues(Array.isArray(data.issues) ? data.issues : [])
      return
    }
    setMessage({ kind: 'ok', text: 'Saved. New leads will use these settings.' })
    router.refresh()
  }

  const accountMissing = !!config.email_account && !accounts.some(a => a.id === config.email_account!.id)

  return (
    <form onSubmit={save} className="space-y-6" aria-describedby="outreach-status">
      <div id="outreach-status">
        {!options.ok && (
          <p role="alert" className="text-[13px]" style={{ color: 'var(--apple-red)' }}>
            {options.notConnected ? 'Connect Apollo on the Connections page first, then come back to choose sequences.' : options.message}
          </p>
        )}
        {options.ok && sequences.length === 0 && (
          <p role="status" className="text-[13px]" style={{ color: 'var(--apple-text-secondary)' }}>
            Your Apollo account has no sequences yet. Create one in Apollo, then refresh this page.
          </p>
        )}
        {options.ok && accounts.length === 0 && (
          <p role="status" className="text-[13px]" style={{ color: 'var(--apple-text-secondary)' }}>
            No mailbox is connected in Apollo yet. Link one in Apollo under Settings → Mailboxes, then refresh this page.
          </p>
        )}
      </div>

      <section className="apple-card p-5 space-y-3" aria-labelledby="mailbox-heading">
        <h2 id="mailbox-heading" className="text-[14px] font-semibold">Send from</h2>
        <div>
          <label htmlFor="email-account" className="text-[12px] font-medium block mb-1">Mailbox</label>
          <select id="email-account" className={`${fieldClass} w-full max-w-md`} disabled={!canEdit || busy}
            value={config.email_account?.id ?? ''} onChange={e => setAccount(e.target.value)}>
            <option value="">Choose a mailbox…</option>
            {accountMissing && <option value={config.email_account!.id}>{config.email_account!.email} (not found in Apollo)</option>}
            {accounts.map(a => (
              <option key={a.id} value={a.id} disabled={!a.active}>
                {a.email}{a.isDefault ? ' (default)' : ''}{a.active ? '' : ' (disconnected in Apollo)'}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="apple-card p-5 space-y-4" aria-labelledby="seq-heading">
        <div>
          <h2 id="seq-heading" className="text-[14px] font-semibold">Sequence for each fit level</h2>
          <p className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>
            Until you choose, leads at that level are flagged for a person instead of being emailed.
          </p>
        </div>
        {TIERS.map(({ tier, label, hint }) => {
          const current = config.tiers[tier]
          const savedMissing = current?.mode === 'sequence' && !sequences.some(s => s.id === current.sequence_id)
          return (
            <div key={tier}>
              <label htmlFor={`seq-${tier}`} className="text-[12px] font-medium block mb-1">{label}</label>
              <select id={`seq-${tier}`} className={`${fieldClass} w-full max-w-md`} disabled={!canEdit || busy}
                aria-describedby={`seq-${tier}-hint`} value={tierValue(current)} onChange={e => setTier(tier, e.target.value)}>
                <option value={UNSET} disabled>Not chosen yet</option>
                <option value={MANUAL}>No sequence (the rep follows up by hand)</option>
                {savedMissing && current?.mode === 'sequence' && (
                  <option value={current.sequence_id}>{current.sequence_name || current.sequence_id} (not found in Apollo)</option>
                )}
                {sequences.map(s => (
                  <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (paused in Apollo)'}</option>
                ))}
              </select>
              <p id={`seq-${tier}-hint`} className="text-[12px] mt-1" style={{ color: 'var(--apple-text-secondary)' }}>{hint}</p>
            </div>
          )
        })}
      </section>

      {message && (
        <div role={message.kind === 'error' ? 'alert' : 'status'} className="text-[13px]"
          style={{ color: message.kind === 'error' ? 'var(--apple-red)' : 'var(--apple-green)' }}>
          <p>{message.text}</p>
          {issues.length > 0 && <ul className="list-disc pl-5">{issues.map(i => <li key={i}>{i.charAt(0).toUpperCase() + i.slice(1)}.</li>)}</ul>}
        </div>
      )}
      {isAdmin
        ? <Button type="submit" disabled={!canEdit || busy || !dirty}>{busy ? 'Saving…' : 'Save'}</Button>
        : <p className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>Only admins can change outreach settings.</p>}
    </form>
  )
}
