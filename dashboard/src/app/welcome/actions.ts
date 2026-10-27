'use server'

import { redirect } from 'next/navigation'
import { getServerToken } from '@/lib/auth'
import { apiFetch } from '@/lib/api'

export type WelcomeState = { error?: string; name?: string }

export async function createWorkspace(_prev: WelcomeState, formData: FormData): Promise<WelcomeState> {
  const name = String(formData.get('name') ?? '').trim()
  if (name.length < 2) return { error: 'Please enter your company or team name.', name }

  const token = await getServerToken()
  const res = await apiFetch('/api/workspaces', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (res.status !== 201 && res.status !== 409) {
    return { error: 'We could not create your workspace. Please try again.', name }
  }
  redirect('/dashboard')
}
