// Weekly payment-plan nudge (Wednesdays 09:00 SAST, 30 Sep to 4 Nov 2026).
// Emails every approved vendor who still owes AND has no payment plan or
// extension in place. Same suppression as payment-reminders (paid, withdrawn,
// person-level twins, master EFT lane, test vendors). Idempotent per day via
// portal_state.plan_nudges. ?dry=1 lists targets without sending.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState, hasPaid, isWithdrawn, getArrangement } from '@/lib/portal-state'
import { buildSuppressedPeople, newSendDeduper } from '@/lib/payments/chase-targeting'
import { sendEmail } from '@/lib/email/resend'
import { VendorPlanNudge } from '@/lib/email/templates/VendorPlanNudge'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { isTestVendor } from '@/lib/test-vendors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const START = '2026-09-30'
const END = '2026-11-04'

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dryRun = req.nextUrl.searchParams.get('dry') === '1'
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  if (!dryRun && (day < START || day > END)) {
    return NextResponse.json({ ok: true, sent: 0, stopped: `outside ${START}..${END}` })
  }

  const admin = createAdminClient()
  const { data: apps, error } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, status, reviewed_at')
    .eq('status', 'approved')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const suppressed = buildSuppressedPeople((apps || []) as never[], now)
  const deduper = newSendDeduper()
  const results: Array<Record<string, unknown>> = []

  for (const app of apps || []) {
    if (isTestVendor(app) || !app.email) continue
    const state = parsePortalState(app.admin_notes as string)
    if (hasPaid(state) || isWithdrawn(state)) continue
    if (suppressed.hardHas(app as never) || suppressed.laneHas(app as never)) continue
    // "No payment plan yet": any proposed/approved plan, or an in-force extension.
    if (state.payment?.arrangement?.installments?.length) continue
    if (getArrangement(state, now) || suppressed.arrangementFor(app as never)) continue
    const nudges = ((state as unknown) as { plan_nudges?: string[] }).plan_nudges || []
    if (nudges.includes(day)) continue
    if (!deduper.claim(app as never)) continue

    const contactName = ((app.contact_name as string) || '').trim().split(/\s+/)[0] || 'there'
    const out: Record<string, unknown> = { id: app.id, business: app.business_name }
    if (!dryRun) {
      const res = await sendEmail({
        to: app.email as string,
        subject: 'An Easier Way to Pay Your Stall Fees',
        react: VendorPlanNudge({ contactName }),
      })
      out.emailSent = res.ok
      if (res.ok) {
        await updatePortalState(app.id as string, (s) => ({
          ...s,
          plan_nudges: [...(((s as unknown) as { plan_nudges?: string[] }).plan_nudges || []), day],
        }) as typeof s)
      }
    }
    results.push(out)
  }

  return NextResponse.json({ ok: true, dryRun, scanned: apps?.length ?? 0, targets: results.length, results })
}
