import { getServerToken } from '@/lib/auth'
import { apiFetch, getMe } from '@/lib/api'
import { OutreachEditor, type OutreachPolicy, type OutreachOptions } from './outreach-editor'

export const dynamic = 'force-dynamic'

export default async function OutreachPage() {
  const token = await getServerToken()
  const [me, policyRes, optionsRes] = await Promise.all([
    getMe(token),
    apiFetch('/api/outreach', token),
    apiFetch('/api/outreach/options', token),
  ])
  const policy: OutreachPolicy | null = policyRes.ok ? await policyRes.json() : null
  const optionsBody = await optionsRes.json().catch(() => ({}))
  const options: OutreachOptions = optionsRes.ok
    ? { ok: true, sequences: optionsBody.sequences ?? [], emailAccounts: optionsBody.emailAccounts ?? [] }
    : {
        ok: false,
        notConnected: optionsBody.error === 'APOLLO_NOT_CONNECTED',
        message: [optionsBody.message ?? 'Could not load your sequences from Apollo.', optionsBody.fix].filter(Boolean).join(' '),
      }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Outreach</h1>
        <p className="text-[13px] mt-1 max-w-2xl" style={{ color: 'var(--apple-text-secondary)' }}>
          After a lead is assigned to a rep, it is added to an Apollo sequence based on how well it fits. Choose the sequence for each fit level and the mailbox that sends the emails.
        </p>
      </header>
      {!policy && (
        <p role="alert" className="text-[13px]" style={{ color: 'var(--apple-red)' }}>
          {policyRes.status === 404
            ? 'Outreach settings are missing for this workspace, so leads are flagged for a person instead of being added to a sequence. Ask an admin to run the latest database update.'
            : 'Outreach settings could not be loaded. Please refresh.'}
        </p>
      )}
      {policy && <OutreachEditor policy={policy} options={options} isAdmin={me.role === 'admin'} />}
    </div>
  )
}
