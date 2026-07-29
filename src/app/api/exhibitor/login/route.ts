import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerSupabase } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  checkIpThrottle,
  logGuardEvent,
  clientIp,
} from '@/lib/security/abuse-guard'

export const dynamic = 'force-dynamic'

const ENDPOINT = 'exhibitor-login'
const MAX_PER_MIN = 5

/**
 * Server-side exhibitor sign-in.
 *
 * Was: client called signInWithPassword directly, no throttle, and surfaced
 * Supabase's raw error message ("Invalid login credentials", "Email not
 * confirmed", etc) which leaks account state. Now: per-IP throttle, single
 * generic error string for every failure mode, sets the Supabase auth cookies
 * via the SSR client so /exhibitor/portal reads the session immediately.
 */
export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid email or password' }, { status: 400 })
  }

  const email = String(body.email || '').trim()
  const password = String(body.password || '')
  if (!email || !password) {
    return NextResponse.json({ error: 'invalid email or password' }, { status: 400 })
  }

  const admin = createAdminClient()
  const ip = clientIp(req.headers)

  const throttle = await checkIpThrottle(admin, {
    ip,
    endpoint: ENDPOINT,
    max: MAX_PER_MIN,
    windowMin: 1,
  })
  if (!throttle.ok) {
    await logGuardEvent(admin, {
      endpoint: ENDPOINT,
      ip,
      reason: throttle.reason!,
      fields: { email_hash_prefix: email.slice(0, 2) },
    })
    return NextResponse.json({ error: 'too many attempts, try again in a minute' }, { status: 429 })
  }

  // Log every attempt so the throttle counter increments even on first hit.
  await logGuardEvent(admin, {
    endpoint: ENDPOINT,
    ip,
    reason: 'rate_limited',
    fields: { kind: 'attempt' },
  })

  const supabase = await createServerSupabase()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error || !data?.user) {
    return NextResponse.json({ error: 'invalid email or password' }, { status: 401 })
  }

  // Tell Taona who just came in, from where, and what is stuck for them.
  // Awaited so the alert is not cut off by the serverless function freezing
  // after the response, but wrapped so telemetry can never fail a sign-in.
  try {
    const { recordVendorLogin } = await import('@/lib/vendor-login-alert')
    await recordVendorLogin(admin, req.headers, data.user)
  } catch (e) {
    console.error('[exhibitor-login] telemetry failed:', (e as Error).message)
  }

  const meta = data.user.user_metadata || {}
  const mustChange = Boolean(meta.must_change_password)
  return NextResponse.json({
    ok: true,
    mustChangePassword: mustChange,
    next: mustChange ? '/exhibitor/set-password' : '/exhibitor/portal',
  })
}
