import { redirect } from 'next/navigation'
import { SidebarNav } from '@/components/sidebar-nav'
import { getServerToken } from '@/lib/auth'
import { getMe } from '@/lib/api'

export const dynamic = 'force-dynamic'

/**
 * Signed-in shell. Users without a workspace are sent to /welcome first.
 * Unfinished setup: admins get a "Finish setup" link (Overview sends them to /setup once per
 * browser session); members see a note, since only admins can set things up.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const token = await getServerToken()
  const me = await getMe(token)
  if (!me.workspace) redirect('/welcome')
  const role = me.role ?? 'member'
  const setupPending = !me.workspace.setupCompleted

  return (
    <div className="flex min-h-screen">
      <SidebarNav workspaceName={me.workspace.name} email={me.user.email} role={role} setupPending={setupPending && role === 'admin'} />
      <main id="main" className="flex-1 ml-60 min-w-0 px-10 py-8">
        <div className="max-w-[1120px] mx-auto">
          {setupPending && role !== 'admin' && (
            <div role="status" className="apple-card px-4 py-3 mb-5 text-[13px]" style={{ color: 'var(--apple-text-secondary)' }}>
              An admin is still setting up this workspace. Some pages stay empty until they finish.
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  )
}
