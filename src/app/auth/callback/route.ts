import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// Auth callback for Supabase email links. Two paths:
//
//   1) token_hash + type  (recovery, magiclink, signup, invite, email_change)
//      — set when the link is admin-minted via generateLink().
//      Stateless: we call supabase.auth.verifyOtp({type, token_hash}) which
//      verifies + writes the session cookie. No code_verifier needed. THIS is
//      what our /api/exhibitor/send-password-reset uses.
//
//   2) ?code= (PKCE)
//      — set when the link is requested via the browser-side signInWith...
//      flows where the code_verifier cookie was set client-side. Kept for any
//      future client-initiated flow.
//
// Both paths land users on `?next=<path>` after a successful exchange. On any
// failure we bounce to /exhibitor/forgot?err=<reason> so the user sees a real
// message (not a dead form). Doctrine Law 7: no em-dashes in user-facing copy.
/**
 * Turn Supabase's "Email link is invalid or has expired" into something a vendor
 * can act on.
 *
 * PROVEN 2026-07-27 against a throwaway account: minting a second recovery link
 * INVALIDATES the first, and the rejected one fails with exactly that message.
 * So the overwhelmingly likely reason a vendor lands here is that they asked for
 * a reset twice and then opened the older email. The raw message tells them
 * nothing, reads like the portal is broken, and turns into a support ticket.
 */
function resetErrorMessage(raw: string): string {
  if (/invalid or has expired/i.test(raw)) {
    return 'That reset link is no longer valid. If you asked for more than one email, only the most recent link works, so open the newest one. Otherwise the link has expired (they last 1 hour), and you can request a new one below.'
  }
  return `Reset link could not be verified: ${raw}. Please request a fresh email.`
}

// Both success paths below establish a session, and until 2026-07-29 neither
// announced it. Raeesa Jenkins signed in through here minutes after her email
// was repaired and nothing said so. announceLogin resolves admin vs vendor
// itself, so this covers both. Best-effort: never block the redirect.
async function announce(req: NextRequest, source: 'reset link') {
  try {
    const supa = await createClient()
    const { data: { user } } = await supa.auth.getUser()
    if (!user) return
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const { announceLogin } = await import('@/lib/login-announce')
    await announceLogin(createAdminClient(), req.headers, user, source)
  } catch (e) {
    console.error('[auth/callback] announce failed:', (e as Error).message)
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type')
  const code = url.searchParams.get('code')
  // Open-redirect guard. `new URL(next, origin)` will happily resolve
  // `//evil.com` to `https://evil.com/`, so we accept ONLY relative paths
  // that start with a single `/` and reject the `//` prefix attacker
  // would use to slip in a host.
  const nextRaw = url.searchParams.get('next') || '/exhibitor/portal'
  const next = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/exhibitor/portal'
  const errorDescription = url.searchParams.get('error_description')

  if (errorDescription) {
    const u = new URL('/exhibitor/forgot', url.origin)
    u.searchParams.set('err', errorDescription)
    return NextResponse.redirect(u)
  }

  const supabase = await createClient()

  // Path 1: token_hash (admin-minted, what password reset uses)
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as 'recovery' | 'magiclink' | 'signup' | 'invite' | 'email_change' | 'email',
    })
    if (error) {
      const u = new URL('/exhibitor/forgot', url.origin)
      u.searchParams.set('err', resetErrorMessage(error.message))
      return NextResponse.redirect(u)
    }
    await announce(req, 'reset link')
    return NextResponse.redirect(new URL(next, url.origin))
  }

  // Path 2: PKCE code (browser-initiated)
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      const u = new URL('/exhibitor/forgot', url.origin)
      u.searchParams.set('err', resetErrorMessage(error.message))
      return NextResponse.redirect(u)
    }
    await announce(req, 'reset link')
    return NextResponse.redirect(new URL(next, url.origin))
  }

  // Neither — link is malformed
  const u = new URL('/exhibitor/forgot', url.origin)
  u.searchParams.set('err', 'Reset link is missing its verification token. Please request a fresh email.')
  return NextResponse.redirect(u)
}
