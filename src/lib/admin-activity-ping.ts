// "Samreen is on the admin panel RIGHT NOW and I got no alert." (Taona,
// 2026-08-01). The login announcer only fires on a FRESH sign-in; her Supabase
// session from 28 July was still alive, so she could work all day without a
// single event. This ping closes that: the first admin page load in a 12-hour
// window records an admin_active event and alerts the master. Fresh logins
// still announce separately through login-announce.ts.
//
// Law 8: rides site_events, no DDL. Best-effort: never throws, never blocks a
// page render (the layout calls it inside after()).

import type { SupabaseClient } from '@supabase/supabase-js'
import { loginFacts, placeLabel } from '@/lib/admin-login-log'

export const PING_WINDOW_MS = 12 * 60 * 60 * 1000

/** Pure, unit-tested. Ping when there is no prior ping or the last one is
 *  older than the window. An unparseable timestamp pings (fail visible). */
export function shouldPing(lastPingIso: string | null | undefined, now = Date.now()): boolean {
  if (!lastPingIso) return true
  const t = new Date(lastPingIso).getTime()
  if (isNaN(t)) return true
  return now - t >= PING_WINDOW_MS
}

type Headers = { get(name: string): string | null }

export async function pingAdminActivity(
  db: SupabaseClient,
  headers: Headers,
  user: { id: string; email?: string | null },
  role: string,
): Promise<void> {
  try {
    const email = (user.email || '').toLowerCase().trim()
    if (!email) return

    // Read-back dedupe: one ping per admin per 12h, however many pages they
    // load. Volume is a handful of rows a day, so a filtered read in JS is
    // fine and avoids relying on PostgREST jsonb operator syntax here.
    const { data } = await db
      .from('site_events')
      .select('created_at, metadata')
      .eq('event_type', 'admin_active')
      .order('created_at', { ascending: false })
      .limit(25)
    const last = ((data || []) as Array<{ created_at: string; metadata: { email?: string } | null }>)
      .find((e) => (e.metadata?.email || '').toLowerCase() === email)?.created_at ?? null

    if (!shouldPing(last)) return

    const facts = loginFacts(headers)
    const place = placeLabel(facts)

    await db.from('site_events').insert({
      session_id: 'admin_active',
      event_type: 'admin_active',
      path: '/admin',
      metadata: {
        actor: email, email, user_id: user.id, role,
        ip: facts.ip, city: facts.city, region: facts.region, country: facts.country, place,
      },
    })

    const lines = [
      `*ADMIN ACTIVE*`,
      `${email} (${role}) is working on the admin panel`,
      `${place}${facts.ip ? ` · ${facts.ip}` : ''}`,
      last ? `Last seen active ${new Date(last).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'First activity recorded',
    ]
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({ event: 'system_alert', audience: 'master', body: lines.join('\n') }).catch(() => {})
  } catch (e) {
    console.error('[admin-activity-ping] failed:', (e as Error).message)
  }
}
