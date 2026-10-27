import { redirect } from 'next/navigation'
import { getServerToken } from '@/lib/auth'
import { getMe } from '@/lib/api'
import { WelcomeForm } from './welcome-form'

export const dynamic = 'force-dynamic'

export default async function WelcomePage() {
  const me = await getMe(await getServerToken())
  if (me.workspace) redirect('/dashboard')

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12" style={{ background: 'var(--apple-bg-desktop)' }}>
      <div className="w-full max-w-[400px] space-y-6">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.015em]">Create your workspace</h1>
          <p className="text-[13px] mt-1 leading-relaxed" style={{ color: 'var(--apple-text-secondary)' }}>
            Signed in as {me.user.email}. A workspace holds your connections, rules and leads. You can invite colleagues afterwards.
          </p>
        </div>
        <div className="apple-card p-5">
          <WelcomeForm />
        </div>
        <p className="text-[12px]" style={{ color: 'var(--apple-text-tertiary)' }}>
          Joining an existing team? Ask an admin to add this email address on their Team page.
        </p>
      </div>
    </main>
  )
}
