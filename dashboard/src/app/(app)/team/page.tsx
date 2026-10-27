import { getServerToken } from '@/lib/auth'
import { apiFetch, getMe } from '@/lib/api'
import { TeamManager, type TeamMember } from './team-manager'

export const dynamic = 'force-dynamic'

export default async function TeamPage() {
  const token = await getServerToken()
  const [me, res] = await Promise.all([getMe(token), apiFetch('/api/team', token)])
  const members: TeamMember[] = res.ok ? (await res.json()).members : []

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Team</h1>
        <p className="text-[13px] mt-1 max-w-2xl" style={{ color: 'var(--apple-text-secondary)' }}>
          Admins can change settings and connections. Members can view leads and approve decisions.
        </p>
      </header>
      {!res.ok && <p role="alert" className="text-[13px]" style={{ color: 'var(--apple-red)' }}>Could not load the team. Please refresh.</p>}
      <TeamManager members={members} currentUserId={me.user.id} isAdmin={me.role === 'admin'}
        signInUrl={process.env.DASHBOARD_URL ?? 'http://localhost:3001'} />
    </div>
  )
}
