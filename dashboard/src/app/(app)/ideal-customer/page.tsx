import { getServerToken } from '@/lib/auth'
import { apiFetch, getMe } from '@/lib/api'
import { IcpEditor, type IcpPolicy } from './icp-editor'

export const dynamic = 'force-dynamic'

export default async function IdealCustomerPage() {
  const token = await getServerToken()
  const [me, res] = await Promise.all([getMe(token), apiFetch('/api/icp', token)])
  const policy: IcpPolicy | null = res.ok ? await res.json() : null
  const missing = res.status === 404

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Ideal customer</h1>
        <p className="text-[13px] mt-1 max-w-2xl" style={{ color: 'var(--apple-text-secondary)' }}>
          Describe the companies and people you want to sell to. Every new lead is scored against this and labelled
          Great fit, Good fit or Not a fit.
        </p>
      </header>
      {policy ? (
        <IcpEditor policy={policy} isAdmin={me.role === 'admin'} />
      ) : (
        <p role="alert" className="text-[13px]" style={{ color: 'var(--apple-red)' }}>
          {missing
            ? 'This workspace has no ideal customer settings yet, so new leads cannot be scored. Ask an admin to run the latest database update.'
            : 'Could not load your ideal customer settings. Please refresh.'}
        </p>
      )}
    </div>
  )
}
