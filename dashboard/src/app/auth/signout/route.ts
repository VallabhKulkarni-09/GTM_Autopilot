import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  await supabase.auth.signOut()
  const base = (process.env.DASHBOARD_URL ?? request.nextUrl.origin).replace(/\/$/, '')
  return NextResponse.redirect(`${base}/login`, { status: 303 })
}
