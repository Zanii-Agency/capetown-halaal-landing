// Accessories-electricity reminder cron (every 3 days).
//
// Chases vendors whose STALL FEE is settled but whose accessory electricity (the
// appliances they booked) is still OWING, scoped to Samreen's side only (Yoco +
// Samreen-EFT), never the covert master lane. One shared predicate
// (accessoryChaseTarget) decides the cohort, so the dry-run preview and the live
// send can never disagree.
//
// Cadence: scheduled daily, but each vendor is messaged at most once per 3 days
// (portal_state.accessory_reminders.history). First eligible run is the first
// notice. STOP is implicit: a vendor drops out the moment their accessories leave
// 'owing' (EFT proof uploaded -> 'pending', or Yoco settled -> 'paid'), i.e. once
// they have paid AND (for EFT) uploaded proof. Runs to the festival date.
//
// Channels: email (VendorAccessoriesReminder, itemised) + WhatsApp
// (festival_announcement utility, accessoryReminderWaBody).
//
// DRY RUN: /api/cron/accessory-reminders?dry=1 returns the target list + message
// previews and sends nothing / records nothing.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'
import { getPaymentRail, getFullEftMode } from '@/lib/eft'
import { accessoryChaseTarget, type AccessoryChaseApp } from '@/lib/payments/accessory-chase'
import { accessoryReminderWaBody, segFromWeek } from '@/lib/payments/reminder-copy'
import { newSendDeduper } from '@/lib/payments/chase-targeting'
import { sendEmail } from '@/lib/email/resend'
import { VendorAccessoriesReminder } from '@/lib/email/templates/VendorAccessoriesReminder'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { verifyCronAuth } from '@/lib/security/cron-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SITE = 'https://cthalaal.co.za'
const PAY_URL = `${SITE}/exhibitor/portal/payments`
// Same guard as the stall-fee cron: nothing to chase past the festival.
const FINAL_SETTLEMENT = new Date('2026-12-11T21:59:59.999Z')
const MIN_DAYS_BETWEEN = 3

interface AccHistory { history?: { at: string; n: number }[] }

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dryRun = req.nextUrl.searchParams.get('dry') === '1'
  const admin = createAdminClient()
  const today = new Date()

  if (today > FINAL_SETTLEMENT) {
    return NextResponse.json({ ok: true, dryRun, scanned: 0, sent: 0, results: [], stopped: 'past festival date' })
  }

  const { data: apps, error } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at, preferred_booth_tier, special_requirements, status')
    .eq('status', 'approved')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Festival-wide reads, once (not per vendor).
  const rail = await getPaymentRail()
  const fullEft = await getFullEftMode()
  const deduper = newSendDeduper()

  const results: Array<Record<string, unknown>> = []
  let owingCohort = 0

  for (const raw of apps || []) {
    const app = raw as AccessoryChaseApp
    const target = accessoryChaseTarget(app, rail, fullEft)
    if (!target) continue
    owingCohort++

    // 3-day spacing from the last accessories reminder (separate history from the
    // stall-fee payment_reminders).
    const acc = (parsePortalState(app.admin_notes ?? '') as unknown as { accessory_reminders?: AccHistory }).accessory_reminders || {}
    const history = acc.history || []
    const lastSent = history.length ? new Date(history[history.length - 1].at) : null
    if (lastSent && daysBetween(lastSent, today) < MIN_DAYS_BETWEEN) continue

    // One message per person per run (duplicate approved rows share a phone/email).
    if (!deduper.claim(app as never)) continue

    const reminderNumber = history.length + 1
    const seg = segFromWeek(reminderNumber)
    const firstName = target.contactName.trim().split(/\s+/)[0] || 'there'

    const out: Record<string, unknown> = {
      id: target.id,
      business: target.businessName,
      owing: target.owing,
      items: target.items,
      payClass: target.payClass,
      reminderNumber,
      email: target.email,
      phone: target.phone,
      waBody: accessoryReminderWaBody(target.owing, seg),
    }

    if (!dryRun) {
      if (target.email) {
        const emailRes = await sendEmail({
          to: target.email,
          subject: reminderNumber >= 3
            ? `Please settle your accessory electricity, ${target.businessName}`
            : `Accessory electricity still due, ${target.businessName}`,
          react: VendorAccessoriesReminder({
            contactName: target.contactName,
            businessName: target.businessName,
            owing: target.owing,
            items: target.items,
            payUrl: PAY_URL,
            reminderNumber,
          }),
        })
        out.emailSent = emailRes.ok
      } else {
        out.emailSent = false
        out.emailSkipped = 'no email'
      }

      if (target.phone) {
        try {
          const waRes = await sendTemplate(
            toE164(target.phone),
            'festival_announcement',
            [firstName, out.waBody as string],
            { category: 'utility' },
          )
          out.waSent = !waRes.skipped
          if (waRes.skipped) out.waSkippedReason = waRes.skipped
        } catch (e) {
          out.waSent = false
          out.waError = (e as Error).message
        }
      } else {
        out.waSent = false
        out.waSkippedReason = 'no phone'
      }

      await updatePortalState(target.id, (s) => {
        const cur = ((s as unknown) as { accessory_reminders?: AccHistory }).accessory_reminders || {}
        const curHistory = cur.history || []
        return {
          ...s,
          accessory_reminders: { ...cur, history: [...curHistory, { at: new Date().toISOString(), n: reminderNumber }] },
        } as typeof s
      })
    }

    results.push(out)
  }

  return NextResponse.json({ ok: true, dryRun, scanned: apps?.length ?? 0, owingCohort, sent: results.length, results })
}
