'use client'

import { useActionState } from 'react'
import { sendMagicLink, type LoginState } from './actions'

const INITIAL: LoginState = { status: 'idle' }

/** Why the last sign-in attempt failed, from /auth/callback (?error=...). */
const LINK_ERRORS: Record<string, string> = {
  link_expired: 'That sign-in link has expired or was already used. Enter your email to get a new one.',
  link_other_browser: 'That sign-in link was opened in a different browser than the one you requested it from. Request a new link and open it in this browser.',
  link_invalid: 'That sign-in link did not work. Enter your email to get a new one.',
}

export function LoginForm({ linkError }: { linkError: string | null }) {
  const [state, formAction, pending] = useActionState(sendMagicLink, INITIAL)
  const linkMessage = state.status === 'idle' && linkError ? (LINK_ERRORS[linkError] ?? LINK_ERRORS.link_invalid) : null

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-12" style={{ background: 'var(--apple-bg-desktop)' }}>
      <div className="w-full max-w-[360px]">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-6 h-6 rounded-[5px] flex items-center justify-center text-[10px] font-semibold text-white" style={{ background: 'var(--ink)' }} aria-hidden="true">GA</div>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--apple-text-primary)' }}>GTM Autopilot</span>
        </div>

        {state.status === 'sent' ? (
          <div role="status" className="space-y-2">
            <h1 className="text-[20px] font-semibold tracking-[-0.015em]">Check your email</h1>
            <p className="text-[13px] leading-relaxed" style={{ color: 'var(--apple-text-secondary)' }}>
              We sent a sign-in link to <span className="font-medium" style={{ color: 'var(--apple-text-primary)' }}>{state.email}</span>.
              Open it in this browser to continue. The link expires after one use.
            </p>
          </div>
        ) : (
          <>
            <h1 className="text-[20px] font-semibold tracking-[-0.015em]">Sign in</h1>
            <p className="text-[13px] mt-1 mb-6" style={{ color: 'var(--apple-text-secondary)' }}>
              Enter your work email and we will send you a sign-in link.
            </p>
            <form action={formAction} className="space-y-4" noValidate>
              {linkMessage && (
                <p role="alert" className="text-[13px] rounded-[8px] p-3 border" style={{ color: 'var(--apple-red)', background: 'var(--tint-red)', borderColor: '#F6D5D2' }}>{linkMessage}</p>
              )}
              <div className="space-y-1.5">
                <label htmlFor="email" className="text-[13px] font-medium">Work email</label>
                <input
                  id="email" name="email" type="email" autoComplete="email" required
                  defaultValue={state.email}
                  aria-invalid={state.status === 'error'}
                  aria-describedby={state.status === 'error' ? 'email-error' : 'email-help'}
                  className="w-full h-9 px-3 rounded-[7px] text-[13px] outline-none border bg-white shadow-[0_1px_1px_rgba(0,0,0,0.03)] focus:border-[color:var(--apple-blue)] focus:ring-[3px] focus:ring-[#2B59C3]/15"
                  style={{ borderColor: 'var(--border-strong)' }}
                  placeholder="you@company.com"
                />
                {state.status === 'error' ? (
                  <p id="email-error" role="alert" className="text-[12px]" style={{ color: 'var(--apple-red)' }}>{state.message}</p>
                ) : (
                  <p id="email-help" className="text-[12px]" style={{ color: 'var(--apple-text-tertiary)' }}>
                    No password needed.
                  </p>
                )}
              </div>
              <button type="submit" disabled={pending}
                className="w-full h-9 rounded-[7px] text-white text-[13px] font-medium disabled:opacity-60 transition-colors hover:bg-[#27272A]"
                style={{ background: 'var(--ink)' }}>
                {pending ? 'Sending link' : 'Continue with email'}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  )
}
