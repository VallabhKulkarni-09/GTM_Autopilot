'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SETUP_SKIPPED_COOKIE } from '@/lib/setup'

/** "Skip for now": lasts until the browser closes. Setup stays unfinished; the sidebar keeps a link to it. */
export async function skipSetup(): Promise<void> {
  const jar = await cookies()
  jar.set(SETUP_SKIPPED_COOKIE, '1', {
    path: '/', httpOnly: true, sameSite: 'lax',
    secure: process.env.DASHBOARD_URL?.startsWith('https://') === true,
  })
  redirect('/dashboard')
}
