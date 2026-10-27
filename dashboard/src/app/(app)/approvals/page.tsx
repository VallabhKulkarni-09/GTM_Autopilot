import { getServerToken } from '@/lib/auth'
import { apiFetch, getMe } from '@/lib/api'
import { ApprovalsList, type Approval, type RepOption } from './approvals-list'

export const dynamic = 'force-dynamic'

export default async function ApprovalsPage() {
  const token = await getServerToken()
  const [me, approvalsRes, repsRes] = await Promise.all([
    getMe(token),
    apiFetch('/api/approvals', token),
    apiFetch('/api/reps', token),
  ])
  const approvals: Approval[] = approvalsRes.ok ? (await approvalsRes.json()).approvals : []
  const reps: RepOption[] = repsRes.ok
    ? ((await repsRes.json()).reps as Array<RepOption & { activeInSalesforce: boolean }>).filter(r => r.activeInSalesforce)
    : []

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Approvals</h1>
        <p className="text-[13px] mt-1 max-w-2xl" style={{ color: 'var(--apple-text-secondary)' }}>
          Leads the autopilot could not handle on its own. Each one stays paused until someone decides, even if the app restarts.
        </p>
      </header>
      {!approvalsRes.ok && <p role="alert" className="text-[13px]" style={{ color: 'var(--apple-red)' }}>Approvals could not be loaded. Please refresh.</p>}
      {approvalsRes.ok && <ApprovalsList approvals={approvals} reps={reps} isAdmin={me.role === 'admin'} />}
    </div>
  )
}
