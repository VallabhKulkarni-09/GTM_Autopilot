import { getServerToken } from '@/lib/auth'
import { apiFetch, getMe } from '@/lib/api'
import { RepsManager, type Rep, type Territory } from './reps-manager'

export const dynamic = 'force-dynamic'

export default async function RepsPage() {
  const token = await getServerToken()
  const [me, repsRes, settingsRes, terrRes] = await Promise.all([
    getMe(token),
    apiFetch('/api/reps', token),
    apiFetch('/api/reps/settings', token),
    apiFetch('/api/territories', token),
  ])
  const reps: Rep[] = repsRes.ok ? (await repsRes.json()).reps : []
  const territories: Territory[] = terrRes.ok ? (await terrRes.json()).territories : []
  const settings: { version: number; maxOpenLeadsPerRep: number } | null = settingsRes.ok ? await settingsRes.json() : null
  const loadFailed = !repsRes.ok || !terrRes.ok || (!settingsRes.ok && settingsRes.status !== 404)

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Reps &amp; territories</h1>
        <p className="text-[13px] mt-1 max-w-2xl" style={{ color: 'var(--apple-text-secondary)' }}>
          Who receives new leads. Leads are shared evenly between available reps in the matching territory, starting with whoever has the fewest open leads.
        </p>
      </header>
      {loadFailed && <p role="alert" className="text-[13px]" style={{ color: 'var(--apple-red)' }}>Some of this page could not be loaded. Please refresh.</p>}
      <RepsManager reps={reps} territories={territories} settings={settings} isAdmin={me.role === 'admin'} />
    </div>
  )
}
