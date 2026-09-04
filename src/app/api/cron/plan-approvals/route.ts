import { NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { approveDuePaymentPlans } from '@/lib/payments/payment-plan'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

// Auto-approve vendor payment plans 5 minutes after they are proposed and
// confirm to the vendor (Taona 2026-09-04, pure auto-approve, no operator veto).
// Runs every 2 minutes, approving any plan proposed at least 5 minutes ago, so a
// vendor is confirmed roughly 5 to 7 minutes after proposing.
export async function GET(req: NextRequest) {
  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}`; fail closed.
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  try {
    const r = await approveDuePaymentPlans()
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    console.error('[cron plan-approvals]', (e as Error).message)
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
