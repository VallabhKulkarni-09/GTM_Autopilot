'use client'

import { useActionState } from 'react'
import { createWorkspace, type WelcomeState } from './actions'

export function WelcomeForm() {
  const [state, formAction, pending] = useActionState(createWorkspace, {} as WelcomeState)
  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="name" className="text-[13px] font-medium">Company or team name</label>
        <input id="name" name="name" required minLength={2} maxLength={120} defaultValue={state.name}
          aria-invalid={Boolean(state.error)} aria-describedby={state.error ? 'name-error' : undefined}
          placeholder="Acme Sales"
          className="w-full h-9 px-3 rounded-[7px] text-[13px] outline-none border border-[color:var(--border-strong)] bg-white focus:border-[color:var(--apple-blue)] focus:ring-[3px] focus:ring-[#2B59C3]/15"
          />
        {state.error && <p id="name-error" role="alert" className="text-[12px]" style={{ color: 'var(--apple-red)' }}>{state.error}</p>}
      </div>
      <button type="submit" disabled={pending}
        className="w-full h-9 rounded-[7px] text-white text-[13px] font-medium disabled:opacity-60 transition-colors hover:bg-[#27272A]"
        style={{ background: 'var(--ink)' }}>
        {pending ? 'Creating…' : 'Create workspace'}
      </button>
    </form>
  )
}
