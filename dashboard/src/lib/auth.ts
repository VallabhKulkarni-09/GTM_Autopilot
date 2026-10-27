import 'server-only'
import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from './supabase/server'

/**
 * Access token of the signed-in user, for server-side calls to the API.
 * Never passed to client components. Redirects to /login when signed out.
 */
export async function getServerToken(): Promise<string> {
  const supabase = await createSupabaseServerClient()
  // getUser() re-validates with Supabase Auth; getSession() alone trusts the cookie.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) redirect('/login')
  return session.access_token
}
