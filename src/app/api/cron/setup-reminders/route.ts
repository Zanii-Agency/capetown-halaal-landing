// Setup reminder cron. Fires the Meta-approved vendor_setup_reminder template
// to every PAID vendor in the window leading up to setup day (Thursday 10 Dec
// 2026). Scheduled daily 07:00 UTC (09:00 SAST). The route is idempotent: it
// only fires if today is within the SETUP_WINDOW and a marker on portal_state
// confirms this vendor hasn't already received the reminder.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState, hasPaid } from '@/lib/portal-state'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { verifyCronAuth } from '@/lib/security/cron-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Send reminders on Dec 8 and Dec 9, 2026 (2 days + 1 day before setup).
// Dec 10 itself = setup day, no reminder needed.
const FIRE_DATES = ['2026-12-08', '2026-12-09']

export async function GET(req: NextRequest) {
  // Defense in depth. Middleware enforces Bearer at the edge, but we
  // re-check here so a misconfigured matcher cannot expose the route.
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = new Date().toISOString().slice(0, 10)
  const dryRun = req.nextUrl.searchParams.get('dry') === '1' || !FIRE_DATES.includes(today)

  const admin = createAdminClient()
  const { data: apps } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, phone, admin_notes, status')
    .eq('status', 'approved')

  const results: Array<Record<string, unknown>> = []
  for (const app of apps || []) {
    const state = parsePortalState(app.admin_notes as string)
    // hasPaid covers 'collected': an EFT-collected vendor has paid and must get
    // their load-in/setup reminder like everyone else.
    if (!hasPaid(state)) continue
    const alreadySent = (state as unknown as { setup_reminder_sent_at?: string }).setup_reminder_sent_at
    if (alreadySent) continue
    if (!app.phone) continue

    const firstName = String(app.contact_name || '').trim().split(/\s+/)[0] || 'there'

    if (dryRun) {
      results.push({ id: app.id, business: app.business_name, action: 'would_send', phone: app.phone })
      continue
    }

    try {
      const res = await sendTemplate(toE164(app.phone as string), 'vendor_setup_reminder', [firstName], { category: 'utility' })
      await updatePortalState(app.id as string, (s) => ({ ...s, setup_reminder_sent_at: new Date().toISOString() } as typeof s))
      results.push({ id: app.id, business: app.business_name, action: res.skipped ? 'skipped' : 'sent', reason: res.skipped })
    } catch (e) {
      results.push({ id: app.id, business: app.business_name, action: 'error', error: (e as Error).message })
    }
  }

  return NextResponse.json({ ok: true, today, dryRun, scanned: apps?.length ?? 0, results })
}
