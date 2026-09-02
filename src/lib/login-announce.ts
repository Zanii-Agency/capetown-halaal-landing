// ONE announcer for every way a session can be created.
//
// Taona 2026-07-29: "make sure when any vendor logs in you tell me including
// samreen and everyone".
//
// FOUR DOORS, AND ONLY TWO WERE LOGGED.
//
//   /api/exhibitor/login   vendor form        logged
//   /admin/login           admin form         logged, but alerted only on an
//                                             unusual location or a new IP
//   /auth/callback         reset / magic link NOT LOGGED AT ALL
//   /login                 a second vendor    NOT LOGGED AT ALL
//                          form, client-side
//
// Raeesa Jenkins signed in through /auth/callback today, minutes after her
// email was repaired, and nothing announced it. That is the same shape as the
// inbox sender rule that went into thirteen readers while a fourteenth surface
// leaked for hours: a rule applied per call site is a rule that misses a door.
//
// So identity resolution, event recording and the alert all live HERE, and every
// door calls this one function. A new sign-in path gets the behaviour by calling
// it, not by remembering to reimplement it.
//
// ALERTS ON EVERY LOGIN, NO EXCEPTIONS. The admin path used to fire only on an
// unusual location or a first-seen IP, on the argument that a daily alert is one
// you stop reading. Taona overruled that: he wants all of them. The unusual
// signal is not lost, it is now a line INSIDE the message rather than the gate
// in front of it.
//
// Law 8: rides site_events, no DDL.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loginFacts, placeLabel, isExpectedPlace } from '@/lib/admin-login-log'

type Headers = { get(name: string): string | null }

/** Where this session came from, for the alert body. */
export type LoginSource = 'admin form' | 'vendor form' | 'reset link' | 'portal'

/** Best-effort telemetry. NEVER throws, never blocks a sign-in: the session is
 *  already established by the time this runs, and losing a login to a failed
 *  alert would be far worse than a missing notification. */
export async function announceLogin(
  db: SupabaseClient,
  headers: Headers,
  user: { id: string; email?: string | null },
  source: LoginSource,
): Promise<void> {
  try {
    const email = (user.email || '').toLowerCase().trim()
    if (!email) return

    const facts = loginFacts(headers)
    const place = placeLabel(facts)
    const expected = isExpectedPlace(facts)

    // ADMIN FIRST. An operator address must never be treated as a vendor even
    // if it also appears on an application row.
    const { data: adminRow } = await db
      .from('admin_users')
      .select('id, email, role')
      .eq('id', user.id)
      .maybeSingle()

    if (adminRow) {
      const who = ((adminRow as { email?: string | null }).email) || email
      const role = (adminRow as { role?: string }).role || 'admin'

      await db.from('site_events').insert({
        session_id: 'admin_login',
        event_type: 'admin_login',
        path: '/admin/login',
        metadata: {
          actor: who, email: who, user_id: user.id, role, source,
          ip: facts.ip, city: facts.city, region: facts.region, country: facts.country,
          place, expected,
        },
      })

      const lines = [
        `*ADMIN LOGIN*`,
        `${who} (${role})`,
        `${place}${facts.ip ? ` · ${facts.ip}` : ''} · via ${source}`,
      ]
      // The unusual signal survives as a line, not as a gate.
      if (!expected) lines.push('', '⚠️ *Not a Cape Town address.*')

      const { notifyOwners } = await import('@/lib/bot/notify')
      await notifyOwners({ event: 'system_alert', audience: 'master', body: lines.join('\n') }).catch(() => {})
      return
    }

    // VENDOR. Reuses the existing summary builder so the alert carries what is
    // stuck for them, not just that they arrived.
    const { recordVendorLogin } = await import('@/lib/vendor-login-alert')
    await recordVendorLogin(db, headers, user, source)
  } catch (e) {
    console.error('[login-announce] failed:', (e as Error).message)
  }
}
