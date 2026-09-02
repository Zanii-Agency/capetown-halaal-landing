// Daily ops digest -> master WhatsApp.
//
// Fires once a day (Vercel cron 18:00 UTC = 20:00 SAST). Composes the day's
// pulse (portal opens, payments received, per-tier Yoco/EFT rotation state) and
// pushes it to the master (Taona) ONLY, via notifyOwners.
//
// notifyOwners is the hardened send path: free-text inside Meta's 24h window,
// `festival_announcement` template out of window, a dev@cthalaal.co.za email
// backstop for system_alert, a 5-min dedupe, and wa_messages logging. It also
// walls the festival owner off from any body that mentions EFT, so the rotation
// content stays master-only. We write no transport code here.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { buildOpsDigest, formatOpsDigestWa } from '@/lib/payments/ops-digest'
import { notifyOwners } from '@/lib/bot/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const digest = await buildOpsDigest()
  const body = formatOpsDigestWa(digest)

  await notifyOwners({ event: 'system_alert', audience: 'master', body }).catch((e) => {
    console.error('[daily-ops-digest] notify failed:', (e as Error).message)
  })

  return NextResponse.json({
    ok: true,
    date: digest.dateLabel,
    opensToday: digest.opensToday.count,
    paymentsToday: digest.paymentsToday.length,
    paidTotal: digest.paidTotal,
    rotationActivated: digest.rotation.activated,
  })
}
