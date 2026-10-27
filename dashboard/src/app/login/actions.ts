'use server'

import { createSupabaseServerClient } from '@/lib/supabase/server'

export type LoginState = { status: 'idle' | 'sent' | 'error'; message?: string; email?: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(email)) return { status: 'error', message: 'Please enter a valid email address.', email }

  const dashboardUrl = (process.env.DASHBOARD_URL ?? 'http://localhost:3001').replace(/\/$/, '')
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${dashboardUrl}/auth/callback`, shouldCreateUser: true },
  })
  if (error) {
    const message = error.status === 429
      ? 'Too many sign-in emails. Please wait a minute and try again.'
      : 'We could not send the sign-in email. Please try again.'
    return { status: 'error', message, email }
  }
  return { status: 'sent', email }
}
