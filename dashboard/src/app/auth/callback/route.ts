/** Magic-link / invite landing: exchange the code for a session, then go to the app. */

import { NextRequest, NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createSupabaseServerClient } from '@/lib/supabase/server'

/** Maps a Supabase auth failure to the reason shown on /login. */
function loginError(message: string, code: string | null): 'link_expired' | 'link_other_browser' | 'link_invalid' {
  const text = `${code ?? ''} ${message}`.toLowerCase()
  if (text.includes('code verifier') || text.includes('code_verifier')) return 'link_other_browser'
  if (text.includes('expired') || text.includes('otp_expired') || text.includes('already been used') || text.includes('invalid flow state')) return 'link_expired'
  return 'link_invalid'
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const base = (process.env.DASHBOARD_URL ?? request.nextUrl.origin).replace(/\/$/, '')

  // Supabase reports link problems as query params (e.g. error_code=otp_expired).
  const providerError = searchParams.get('error_code') ?? searchParams.get('error')
  if (providerError) {
    const description = searchParams.get('error_description') ?? ''
    console.warn(`[auth/callback] Supabase returned ${providerError}: ${description}`)
    return NextResponse.redirect(`${base}/login?error=${loginError(description, providerError)}`)
  }

  const supabase = await createSupabaseServerClient()
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null

  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error('link has no code or token_hash') }

  if (error) {
    const errCode = (error as { code?: string }).code ?? null
    console.warn(`[auth/callback] sign-in failed (${errCode ?? 'no code'}): ${error.message}`)
    return NextResponse.redirect(`${base}/login?error=${loginError(error.message, errCode)}`)
  }
  return NextResponse.redirect(`${base}/dashboard`)
}
