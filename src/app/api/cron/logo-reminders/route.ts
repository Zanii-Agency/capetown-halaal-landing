// Weekly logo-reminder cron.
//
// Fires daily (Vercel cron); each run re-nudges any PAID vendor who still has
// no logo and whose last reminder was >= 7 days ago (or who was never reminded).
// Per-vendor cadence is enforced by logo_prompt_sent_at inside the sweep, so a
// daily trigger naturally spaces each vendor's reminders to weekly. Reminders
// stop automatically once the vendor uploads a logo. Email (Resend) + WhatsApp
// (vendor_logo_reminder template) both go out.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { runLogoReminderSweep } from '@/lib/logo-reminder'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}`.
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dry') === '1'
  try {
    const result = await runLogoReminderSweep({ dryRun, minDaysBetween: 7 })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
