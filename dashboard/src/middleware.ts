/**
 * Refreshes the Supabase session cookie on every request and sends signed-out
 * visitors to /login. Workspace/role checks happen in the (app) layout.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const PUBLIC_PATHS = ['/login', '/auth/callback']

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    return new NextResponse('Sign-in is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY.', { status: 500 })
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
      },
    },
  })

  const path = request.nextUrl.pathname

  // If Supabase sent the sign-in link to another page (e.g. the Site URL "/" because
  // /auth/callback is not in its Redirect URLs list), forward it instead of dropping it.
  const params = request.nextUrl.searchParams
  if (path !== '/auth/callback' && (params.has('code') || params.has('token_hash') || params.has('error_code'))) {
    const callback = request.nextUrl.clone()
    callback.pathname = '/auth/callback'
    return NextResponse.redirect(callback)
  }

  const { data: { user } } = await supabase.auth.getUser()
  const isPublic = PUBLIC_PATHS.some(p => path === p || path.startsWith(`${p}/`))

  // API proxy answers 401 itself (JSON), never a redirect.
  if (!user && !isPublic && !path.startsWith('/api/')) {
    const login = request.nextUrl.clone()
    login.pathname = '/login'
    login.search = ''
    return NextResponse.redirect(login)
  }
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
