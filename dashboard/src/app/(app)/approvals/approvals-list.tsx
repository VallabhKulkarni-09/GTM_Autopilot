'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/chip-input'
import { reviewReason, since } from '@/lib/review-labels'

export type Approval = {
  playId: string
  leadId: string
  lead: { name: string; email: string | null; title: string | null; company: string | null }
  kind: 'routing' | 'sequence'
  reasonCodes: string[]
  suggestedOwner: string | null
  sequenceName: string | null
  waitingSince: string | null
  responseDeadline: string
  slaBreached: boolean
  decision: { decision: 'approved' | 'rejected'; decidedAt: string } | null
}
export type RepOption = { id: string; name: string; available: boolean }
type Message = { kind: 'ok' | 'error'; text: string } | null

export function ApprovalsList({ approvals, reps, isAdmin }: { approvals: Approval[]; reps: RepOption[]; isAdmin: boolean }) {
  if (approvals.length === 0) {
    return (
      <div className="apple-card p-8 text-center">
        <p className="text-[14px] font-medium">Nothing waiting</p>
        <p className="text-[13px] mt-1" style={{ color: 'var(--apple-text-secondary)' }}>
          When a lead needs a person to decide, it shows up here.
        </p>
      </div>
    )
  }
  return (
    <ul className="space-y-3" aria-label="Leads waiting for review">
      {approvals.map(a => <ApprovalCard key={a.playId} approval={a} reps={reps} isAdmin={isAdmin} />)}
    </ul>
  )
}

function ApprovalCard({ approval: a, reps, isAdmin }: { approval: Approval; reps: RepOption[]; isAdmin: boolean }) {
  const router = useRouter()
  const [repId, setRepId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  const headingId = `approval-${a.playId}`
  const needsRep = a.kind === 'routing' && !a.suggestedOwner

  async function decide(action: 'approve' | 'reject') {
    setBusy(true)
    setMessage(null)
    const body = { ...(action === 'approve' && repId ? { repId } : {}), ...(note.trim() ? { note: note.trim() } : {}) }
    const res = await fetch(`/api/plays/${a.playId}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      setMessage({ kind: 'error', text: data.message ?? 'Something went wrong. Please try again.' })
      return
    }
    setMessage({ kind: 'ok', text: action === 'approve' ? 'Approved. The lead is moving again.' : 'Rejected. The lead is moving again.' })
    router.refresh()
  }

  const approveLabel = a.kind === 'sequence' ? 'Approve and add to sequence' : 'Assign'
  const rejectLabel = a.kind === 'sequence' ? 'No sequence, rep follows up' : 'Don’t assign, move to nurture'

  return (
    <li className="apple-card p-5 space-y-3" aria-labelledby={headingId}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-[14px] font-semibold">
            <Link href={`/leads/${a.leadId}`} className="hover:underline">{a.lead.name}</Link>
          </h2>
          <p className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>
            {[a.lead.title, a.lead.company, a.lead.email].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="text-right text-[12px] shrink-0" style={{ color: 'var(--apple-text-secondary)' }}>
          <p>Waiting {since(a.waitingSince)}</p>
          {a.slaBreached && <p style={{ color: 'var(--apple-red)' }}>Response time missed</p>}
        </div>
      </div>

      <div className="text-[13px]">
        <p className="font-medium">{a.kind === 'sequence' ? 'Sequence needs sign-off' : 'No rep could be picked automatically'}</p>
        <ul className="list-disc pl-5" style={{ color: 'var(--apple-text-secondary)' }}>
          {a.reasonCodes.length === 0 && <li>Needs a person to decide</li>}
          {a.reasonCodes.map(c => <li key={c}>{reviewReason(c)}</li>)}
          {a.suggestedOwner && <li>Suggested rep: {a.suggestedOwner}</li>}
          {a.sequenceName && <li>Sequence: {a.sequenceName}</li>}
        </ul>
      </div>

      {a.decision ? (
        <p role="status" className="text-[13px]" style={{ color: 'var(--apple-text-secondary)' }}>
          {a.decision.decision === 'approved' ? 'Approved' : 'Rejected'} {since(a.decision.decidedAt)} ago. Continuing…
        </p>
      ) : isAdmin ? (
        <div className="flex flex-wrap items-end gap-3">
          {a.kind === 'routing' && (
            <div>
              <label htmlFor={`rep-${a.playId}`} className="text-[12px] font-medium block mb-1">Assign to</label>
              <select id={`rep-${a.playId}`} className={`${fieldClass} w-56`} value={repId} disabled={busy}
                onChange={e => setRepId(e.target.value)}>
                <option value="">{a.suggestedOwner ? `Suggested: ${a.suggestedOwner}` : 'Choose a rep…'}</option>
                {reps.map(r => <option key={r.id} value={r.id}>{r.name}{r.available ? '' : ' (away)'}</option>)}
              </select>
            </div>
          )}
          <div className="flex-1 min-w-[12rem]">
            <label htmlFor={`note-${a.playId}`} className="text-[12px] font-medium block mb-1">Note (optional)</label>
            <input id={`note-${a.playId}`} className={`${fieldClass} w-full`} maxLength={1000} value={note} disabled={busy}
              onChange={e => setNote(e.target.value)} />
          </div>
          <Button type="button" disabled={busy || (needsRep && !repId)} onClick={() => void decide('approve')}>{approveLabel}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void decide('reject')}>{rejectLabel}</Button>
        </div>
      ) : (
        <p className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>Only admins can approve or reject.</p>
      )}
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className="text-[13px]"
          style={{ color: message.kind === 'error' ? 'var(--apple-red)' : 'var(--apple-green)' }}>{message.text}</p>
      )}
    </li>
  )
}
