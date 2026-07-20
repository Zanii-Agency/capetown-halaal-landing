/**
 * GET /api/cron/festival-reminders
 *
 * Festival reminder cron. Fires daily. Each run computes the days remaining
 * to the festival start (FESTIVAL_DATE) and dispatches a reminder for the
 * three windows we care about: T-7, T-3, T-1.
 *
 * Audiences:
 *   - Approved vendors (status='approved'): "load-in details" reminder.
 *   - Ticket buyers (WC orders status='completed' or 'processing', filtered
 *     by festival cycle per Law 6): "festival day" reminder.
 *
 * Idempotency:
 *   - Vendor reminders mark `portal.festival_reminders.sent[<window>] = ISO`
 *     in admin_notes via updatePortalState. A subsequent run for the same
 *     window skips already-sent vendors.
 *   - Ticket buyer reminders track via a `ticket_reminders` table-less marker:
 *     site_events.event_type = 'festival_reminder_buyer' with metadata
 *     { order_id, window }. We query that BEFORE sending and skip dupes.
 *
 * Vercel cron config (add to vercel.json):
 *   { "path": "/api/cron/festival-reminders", "schedule": "0 8 * * *" }
 *   (08:00 UTC = 10:00 SAST.) Main session adds the entry — this slice
 *   does NOT touch vercel.json (per spec).
 *
 * Channels:
 *   - Email via sendZaniiMail (Resend) + plain HTML body.
 *   - WhatsApp via sendTemplate('general_announcement', ...).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'
import { sendZaniiMail, pacer } from '@/lib/mail/zanii-sender'
import { sendTemplate } from '@/lib/whatsapp/sender'
import { buildUnsubUrl } from '@/lib/mail/unsubscribe-token'
import { getOrders } from '@/lib/woocommerce'
import { verifyCronAuth } from '@/lib/security/cron-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FESTIVAL_DATE = (process.env.FESTIVAL_DATE || '2026-12-11T00:00:00Z')
const WINDOWS = [7, 3, 1] as const
type Window = (typeof WINDOWS)[number]

function dayDiff(target: Date, now: Date): number {
  const ms = target.getTime() - now.getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

function vendorCopy(window: Window, businessName: string): { subject: string; body: string } {
  const subject = window === 7
    ? 'Load-in week is coming, Young at Heart 2026'
    : window === 3
      ? 'Three days to load-in, Young at Heart 2026'
      : 'Load-in tomorrow, Young at Heart 2026'

  const intro = `Hi ${businessName ? `${businessName} team` : 'team'},`
  const lines = window === 7
    ? [
        'Young at Heart Festival starts in one week.',
        'Load-in details, stall code, and your gate entry are in the portal.',
        'Bring your stall code, photo ID, vehicle registration, and your signed contract.',
      ]
    : window === 3
      ? [
          'Three days until Young at Heart at Youngsfield Military Base.',
          'Check your portal for the exact load-in time for your section.',
          'Reply to this email if any detail is unclear.',
        ]
      : [
          'Load-in opens tomorrow.',
          'Bring stall code, photo ID, vehicle registration, signed contract.',
          'Gate 2 is the vendor entrance. Security will direct you.',
        ]

  const body = [intro, '', ...lines, '', 'Warm regards,', 'The Young at Heart Festival Team'].join('\n')
  return { subject, body }
}

function buyerCopy(window: Window): { subject: string; body: string } {
  const subject = window === 7
    ? 'Young at Heart Festival is one week away'
    : window === 3
      ? 'Three days until Young at Heart Festival'
      : 'Tomorrow: Young at Heart Festival'

  const lines = window === 7
    ? [
        'Hi there,',
        '',
        'Your tickets to Young at Heart 2026 are confirmed. Doors open Friday 11 December.',
        'Bring the QR code on your ticket. Children under 6 enter free with an adult.',
        'See you at Youngsfield Military Base, Cape Town.',
      ]
    : window === 3
      ? [
          'Hi there,',
          '',
          'Three days to go. Your QR ticket is in your inbox already.',
          'Parking opens at 10:00. The closest gate is Gate 1.',
        ]
      : [
          'Hi there,',
          '',
          'See you tomorrow at Young at Heart Festival.',
          'Doors open 11:00. Bring your QR ticket and a valid ID.',
        ]

  const body = [...lines, '', 'Warm regards,', 'Young at Heart Festival'].join('\n')
  return { subject, body }
}

function htmlize(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
  return `<div style="font-family:Inter,Arial,sans-serif;color:#1B1A17;line-height:1.55;font-size:15px">` +
         escaped.split('\n').map((l) => l.trim() ? `<p style="margin:0 0 12px">${l}</p>` : '<br/>').join('') +
         `</div>`
}

export async function GET(req: NextRequest) {
  // Fail-closed cron gate: verifyCronAuth returns false when CRON_SECRET is
  // unset, so this route is NEVER publicly triggerable. It sends a real mass
  // email + WhatsApp blast to every approved vendor and ticket buyer, so the
  // gate must not depend on a config var being present to be enforced.
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dry') === '1'
  const forceWindow = req.nextUrl.searchParams.get('window')
  const forceFlag = req.nextUrl.searchParams.get('force') === '1'
  const now = new Date()
  const festival = new Date(FESTIVAL_DATE)
  const diff = dayDiff(festival, now)

  // Decide which window fires THIS run. Allow override via ?window=N for tests.
  const active: Window | null = forceWindow && WINDOWS.includes(Number(forceWindow) as Window)
    ? (Number(forceWindow) as Window)
    : (WINDOWS as readonly number[]).includes(diff)
      ? (diff as Window)
      : null

  if (!active) {
    return NextResponse.json({ ok: true, skipped: 'no window today', diff_days: diff, festival_date: FESTIVAL_DATE })
  }

  // H7 (Smoke Agent F): even with a valid bearer, refuse if the requested
  // window does not match today's diff (+/- 1 day). Smoke test fired
  // ?window=7 179 days early and dispatched REAL T-7 emails to 4 vendors +
  // 2 buyers. Real cron at T-7 will naturally satisfy this guard; manual
  // tests must opt in with ?force=1.
  const windowMatches = Math.abs(diff - active) <= 1
  if (!windowMatches && !forceFlag) {
    // Best-effort replay-defense log so we can spot future smoke firings.
    try {
      const db = createAdminClient()
      await db.from('site_events').insert({
        session_id: 'festival-reminder',
        event_type: 'festival_reminder_blocked',
        path: '/api/cron/festival-reminders',
        metadata: { window: active, diff_days: diff, festival_date: FESTIVAL_DATE, reason: 'window_mismatch' },
      })
    } catch { /* swallow */ }
    return NextResponse.json({
      ok: false,
      error: 'window_mismatch',
      window: active,
      diff_days: diff,
      festival_date: FESTIVAL_DATE,
      hint: 'pass ?force=1 to override',
    }, { status: 412 })
  }

  const db = createAdminClient()
  const results = {
    window: active,
    diff_days: diff,
    festival_date: FESTIVAL_DATE,
    vendors:  { attempted: 0, sent: 0, failed: 0, skipped_already: 0, errors: [] as string[] },
    buyers:   { attempted: 0, sent: 0, failed: 0, skipped_already: 0, errors: [] as string[] },
    dry_run: dryRun,
  }

  // ── Vendors ────────────────────────────────────────────────────────────────
  const { data: vendors } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes')
    .eq('status', 'approved')

  for (const v of (vendors || []) as Array<{
    id: string; business_name: string | null; contact_name: string | null;
    email: string | null; phone: string | null; admin_notes: string | null;
  }>) {
    const state = parsePortalState(v.admin_notes || '')
    const sentMap = (state as unknown as { festival_reminders?: { sent?: Record<string, string> } }).festival_reminders?.sent || {}
    if (sentMap[String(active)]) {
      results.vendors.skipped_already++
      continue
    }
    results.vendors.attempted++
    if (dryRun) { results.vendors.sent++; continue }

    const copy = vendorCopy(active, v.business_name || '')

    // Email
    const email = (v.email || '').trim().toLowerCase()
    if (email) {
      const unsub = buildUnsubUrl(email)
      const r = await sendZaniiMail({
        to: email,
        subject: copy.subject,
        text: copy.body,
        html: htmlize(copy.body),
        unsubscribeToken: unsub.split('/').pop(),
        tags: [
          { name: 'template', value: `festival_reminder_t-${active}` },
          { name: 'audience', value: 'vendor' },
        ],
      })
      if (!r.ok) results.vendors.errors.push(`mail ${email}: ${r.error}`)
      await pacer(250)
    }

    // WhatsApp
    const phone = (v.phone || '').replace(/[^0-9]/g, '')
    if (phone && phone.length >= 9) {
      const r = await sendTemplate({
        to: phone,
        template: 'general_announcement',
        variables: [
          v.contact_name?.trim().split(/\s+/)[0] || 'there',
          v.business_name || '',
          '',
          copy.body.slice(0, 800),
        ].filter((s) => s && s.length > 0),
      })
      if (!r.ok && !r.skipped) results.vendors.errors.push(`wa ${phone}: ${r.error}`)
      await pacer(250)
    }

    results.vendors.sent++
    // H7 replay-defense log.
    try {
      await db.from('site_events').insert({
        session_id: 'festival-reminder',
        event_type: 'festival_reminder_attempt',
        path: '/api/cron/festival-reminders',
        metadata: { audience: 'vendor', application_id: v.id, window: active, email: v.email, diff_days: diff },
      })
    } catch { /* swallow */ }
    try {
      await updatePortalState(v.id, (s) => {
        const fr = (s as unknown as { festival_reminders?: { sent?: Record<string, string> } }).festival_reminders || { sent: {} }
        const sent: Record<string, string> = { ...(fr.sent || {}), [String(active)]: new Date().toISOString() }
        return { ...s, ...(({ festival_reminders: { sent } } as unknown) as Record<string, unknown>) }
      })
    } catch (e) {
      results.vendors.errors.push(`marker ${v.id}: ${(e as Error).message}`)
    }
  }

  // ── Ticket buyers ──────────────────────────────────────────────────────────
  // Pull paid orders for the festival cycle. WC after= filter is enforced in
  // lib/woocommerce.ts (Law 6).
  let orders: Awaited<ReturnType<typeof getOrders>> = []
  try {
    orders = await getOrders({ status: 'completed,processing' })
  } catch (e) {
    results.buyers.errors.push(`wc fetch: ${(e as Error).message}`)
  }

  // Dedupe vs prior sends via site_events markers.
  const alreadySent = new Set<string>()
  try {
    const { data: priorEvents } = await db
      .from('site_events')
      .select('metadata')
      .eq('event_type', 'festival_reminder_buyer')
      .limit(5000)
    for (const e of (priorEvents || []) as Array<{ metadata: { order_id?: number; window?: number } | null }>) {
      const m = e.metadata
      if (m && m.window === active && m.order_id) alreadySent.add(`${m.order_id}:${active}`)
    }
  } catch { /* table may not exist; fall through and send freshly */ }

  const seenBuyers = new Set<string>()
  for (const o of orders) {
    const email = (o.billing?.email || '').trim().toLowerCase()
    if (!email || seenBuyers.has(email)) continue
    seenBuyers.add(email)
    const key = `${o.id}:${active}`
    if (alreadySent.has(key)) { results.buyers.skipped_already++; continue }
    results.buyers.attempted++
    if (dryRun) { results.buyers.sent++; continue }

    const copy = buyerCopy(active)
    const unsub = buildUnsubUrl(email)
    const r = await sendZaniiMail({
      to: email,
      subject: copy.subject,
      text: copy.body,
      html: htmlize(copy.body),
      unsubscribeToken: unsub.split('/').pop(),
      tags: [
        { name: 'template', value: `festival_reminder_t-${active}` },
        { name: 'audience', value: 'buyer' },
      ],
    })
    if (!r.ok) { results.buyers.failed++; results.buyers.errors.push(`mail ${email}: ${r.error}`); continue }
    results.buyers.sent++

    try {
      await db.from('site_events').insert({
        session_id: 'festival-reminder',
        event_type: 'festival_reminder_buyer',
        path: '/api/cron/festival-reminders',
        metadata: { order_id: o.id, window: active, email },
      })
    } catch { /* swallow */ }
    await pacer(250)
  }

  return NextResponse.json({ ok: true, ...results })
}
