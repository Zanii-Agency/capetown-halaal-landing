/**
 * POST /api/admin/vendors/logo-campaign
 *
 * Manual operator trigger for the logo-upload reminder (email + WhatsApp) to
 * paid vendors who have not uploaded a logo. The actual logic lives in
 * lib/logo-reminder.ts and is shared with the on-payment hook (confirmPayment)
 * and the weekly cron (/api/cron/logo-reminders).
 *
 * Body (all optional):
 *   { dryRun?: boolean, force?: boolean, minDaysBetween?: number, limit?: number,
 *     channels?: { email?: boolean, whatsapp?: boolean } }
 *   - dryRun: preview counts without sending.
 *   - force: ignore the per-vendor cadence and send to everyone paid + no logo.
 *   - minDaysBetween: re-nudge cadence (default 7; only those due are sent).
 *
 * Auth: owner | operator OR a CRON_SECRET bearer.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { runLogoReminderSweep } from '@/lib/logo-reminder'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    const gate = await requireOperator()
    if (!gate.ok) return gate.response
  }

  const body = await req.json().catch(() => ({})) as {
    dryRun?: boolean; force?: boolean; minDaysBetween?: number; limit?: number
    channels?: { email?: boolean; whatsapp?: boolean }
  }

  try {
    const result = await runLogoReminderSweep({
      dryRun: body.dryRun === true,
      force: body.force === true,
      minDaysBetween: body.minDaysBetween,
      limit: body.limit,
      channels: body.channels,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
