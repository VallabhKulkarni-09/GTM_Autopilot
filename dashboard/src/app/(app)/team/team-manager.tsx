'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export type TeamMember = { userId: string; email: string; role: 'admin' | 'member'; addedAt: string }

type Props = { members: TeamMember[]; currentUserId: string; isAdmin: boolean; signInUrl: string }

async function call(method: string, path: string, body?: unknown): Promise<string | null> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.ok) return null
  const data = await res.json().catch(() => ({}))
  return data.message ?? 'Something went wrong. Please try again.'
}

export function TeamManager({ members, currentUserId, isAdmin, signInUrl }: Props) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  async function run(action: () => Promise<string | null>, success: string) {
    setBusy(true)
    setMessage(null)
    const error = await action()
    setBusy(false)
    setMessage(error ? { kind: 'error', text: error } : { kind: 'ok', text: success })
    if (!error) router.refresh()
  }

  return (
    <div className="space-y-6">
      {isAdmin && (
        <form className="apple-card p-5 space-y-3"
          onSubmit={e => {
            e.preventDefault()
            const invited = email.trim()
            void run(() => call('POST', '/api/team', { email: invited, role }),
              `${invited} was added. Ask them to sign in at ${signInUrl} with this email.`)
              .then(() => setEmail(''))
          }}>
          <h2 className="text-[14px] font-semibold">Add a teammate</h2>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[220px]">
              <label htmlFor="invite-email" className="text-[12px] font-medium block mb-1">Email</label>
              <input id="invite-email" type="email" required value={email} onChange={e => setEmail(e.target.value)}
                placeholder="colleague@company.com"
                className="w-full h-9 px-3 rounded-[7px] text-[13px] border border-[color:var(--border-strong)] bg-white outline-none focus:border-[color:var(--apple-blue)] focus:ring-[3px] focus:ring-[#2B59C3]/15" />
            </div>
            <div>
              <label htmlFor="invite-role" className="text-[12px] font-medium block mb-1">Access</label>
              <select id="invite-role" value={role} onChange={e => setRole(e.target.value as 'admin' | 'member')}
                className="h-9 px-2 rounded-[7px] text-[13px] border border-[color:var(--border-strong)] bg-white">
                <option value="member">Member — view and approve</option>
                <option value="admin">Admin — can change settings</option>
              </select>
            </div>
            <Button type="submit" disabled={busy || !email}>{busy ? 'Adding…' : 'Add'}</Button>
          </div>
        </form>
      )}

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className="text-[13px]"
          style={{ color: message.kind === 'error' ? 'var(--apple-red)' : 'var(--apple-green)' }}>
          {message.text}
        </p>
      )}

      <div className="apple-card overflow-hidden">
        <table className="w-full text-[13px]">
          <caption className="sr-only">Workspace members</caption>
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide" style={{ color: 'var(--apple-text-tertiary)' }}>
              <th scope="col" className="px-5 py-3 font-medium">Email</th>
              <th scope="col" className="px-5 py-3 font-medium">Access</th>
              {isAdmin && <th scope="col" className="px-5 py-3 font-medium"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.userId} className="border-t" style={{ borderColor: 'var(--apple-separator)' }}>
                <td className="px-5 py-3">{m.email}{m.userId === currentUserId && <span className="ml-2 text-[11px] text-[color:var(--apple-text-tertiary)]">(you)</span>}</td>
                <td className="px-5 py-3">
                  {isAdmin ? (
                    <select aria-label={`Access for ${m.email}`} value={m.role} disabled={busy}
                      onChange={e => void run(() => call('PATCH', `/api/team/${m.userId}`, { role: e.target.value }), 'Access updated.')}
                      className="h-8 px-2 rounded-[7px] text-[13px] border border-[color:var(--border-strong)] bg-white">
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  ) : (m.role === 'admin' ? 'Admin' : 'Member')}
                </td>
                {isAdmin && (
                  <td className="px-5 py-3 text-right">
                    <button type="button" disabled={busy} className="h-7 px-2 rounded-[6px] text-[12px] font-medium hover:bg-[color:var(--tint-red)] disabled:opacity-50"
                      style={{ color: 'var(--apple-red)' }}
                      onClick={() => { if (confirm(`Remove ${m.email} from this workspace?`)) void run(() => call('DELETE', `/api/team/${m.userId}`), `${m.email} was removed.`) }}>
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
