/**
 * Same-origin proxy: browser → /api/* (this Next app) → backend API.
 * The user's access token is attached here, server-side; it never reaches the browser.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { apiBaseUrl } from '@/lib/api'

export const dynamic = 'force-dynamic'

const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'x-workspace-id']

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: { session } } = await supabase.auth.getSession()
  if (!user || !session) {
    return NextResponse.json({ error: 'MISSING_TOKEN', message: 'Please sign in.' }, { status: 401 })
  }

  const { path } = await params
  const target = new URL(`${apiBaseUrl()}/api/${path.map(encodeURIComponent).join('/')}`)
  target.search = req.nextUrl.search

  const headers = new Headers({ Authorization: `Bearer ${session.access_token}` })
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h)
    if (v) headers.set(h, v)
  }

  const hasBody = !['GET', 'HEAD'].includes(req.method)
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    cache: 'no-store',
  })

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE }
