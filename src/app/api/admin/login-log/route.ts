import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { notifyOwners } from '@/lib/bot/notify'
import { loginFacts, placeLabel, shouldAlert, alertBody, isExpectedPlace } from '@/lib/admin-login-log'

// Records WHERE an admin signed in from. Called by the login page right after a
// successful signInWithPassword (admin auth is client-side, so this is the only
// moment a server sees the request).
//
// The client sends NOTHING. Identity comes from the session cookie the sign-in
// just set, and the IP and geo come from the edge headers. A body-supplied
// email or IP would be attacker-controlled and would make the log a place to
// write fiction rather than a record.
//
// Law 8: no DDL on this project. Rides site_events (session_id / event_type /
// path / metadata), which is also what /admin/settings/activity already reads,
// so the logins show up on a surface that exists rather than needing a new one.
export async function POST() {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const { data: row } = await db
    .from('admin_users')
    .select('id, email, role')
    .eq('id', user.id)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const email = ((row as { email?: string | null }).email) || user.email || 'unknown'
  const f = loginFacts(await headers())

  // Every login is recorded, whether or not it alerts.
  await db.from('site_events').insert({
    session_id: 'admin_login',
    event_type: 'admin_login',
    path: '/admin/login',
    metadata: {
      // `actor` is what the activity feed reads to name who did this.
      actor: email,
      email,
      user_id: user.id,
      role: (row as { role?: string }).role ?? null,
      ip: f.ip,
      city: f.city,
      region: f.region,
      country: f.country,
      place: placeLabel(f),
      expected: isExpectedPlace(f),
    },
  })

  // "Have we seen this IP under THIS admin before?" Scoped per admin on
  // purpose: her home IP being familiar is no reason to stay quiet when the
  // same IP shows up under a different account.
  //
  // The query runs AFTER the insert, so the row just written is in the result.
  // Hence `> 1` rather than `> 0`: one occurrence IS this login.
  const { data: prior } = await db
    .from('site_events')
    .select('metadata')
    .eq('event_type', 'admin_login')
    .order('created_at', { ascending: false })
    .limit(500)
  const seenBefore = !!f.ip && (prior || [])
    .map((r) => (r as { metadata?: { email?: string; ip?: string } }).metadata)
    .filter((m) => m?.email === email && m?.ip === f.ip)
    .length > 1

  if (shouldAlert(f, seenBefore)) {
    const firstTime = !seenBefore
    // audience:'master' — this is Taona watching his own portal, not festival
    // ops. Best-effort: a notify failure must never fail the login.
    await notifyOwners({
      event: 'system_alert',
      audience: 'master',
      body: alertBody(email, f, firstTime),
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}
