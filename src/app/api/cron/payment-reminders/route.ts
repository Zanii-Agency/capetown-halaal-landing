// Weekly payment-reminder cron.
//
// Fires once per day (Vercel cron at 09:00 SAST = 07:00 UTC). On every run:
//
//   1. Pull every approved vendor whose payment_status != 'paid' (or unset).
//   2. For each vendor, decide whether they're due for a reminder THIS run.
//      A reminder is due if:
//        - Approval happened at least 7 days ago, AND
//        - Either no previous reminder fired, OR the last reminder fired
//          at least 7 days ago, AND
//        - Today is on or before FINAL_SETTLEMENT (31 Aug 2026). A vendor who
//          cannot meet their own due date may settle in full up to that date and
//          keeps their space until then, so reminders run to it. (This replaced a
//          due-date + 14 day cutoff, which went silent for the weeks right before
//          the date vendors were actually being held to.)
//   3. Send an email (VendorPaymentReminder) AND a WhatsApp template
//      (vendor_payment_reminder) for each due vendor. Record the send
//      timestamp + week number in portal_state.payment_reminders.
//
// Tone hardens slightly week-by-week (TONES[1..4] in the email template). The
// WA body is fixed at the Meta-approved wording.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'
import { computeVendorPricing, formatRand } from '@/lib/payments/pricing'
import { sendEmail } from '@/lib/email/resend'
import { VendorPaymentReminder } from '@/lib/email/templates/VendorPaymentReminder'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { verifyCronAuth } from '@/lib/security/cron-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SITE = 'https://cthalaal.co.za'

// Final settlement date for the 2026 cycle: 31 Aug 2026, 23:59 SAST (UTC+2).
// A vendor who cannot meet their own payment due date may settle in full up to
// this date and keeps their reserved space until then. That concession is offered
// ON REQUEST only and is never volunteered (see the PART PAYMENTS block in
// lib/festival-brain/system-prompt.ts), but it is the real date vendors are held
// to, so reminders must run to it rather than stopping shortly after each
// vendor's own due date. Per-vendor due dates are unchanged.
const FINAL_SETTLEMENT = new Date('2026-08-31T21:59:59.999Z')

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
}

export async function GET(req: NextRequest) {
  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}`. Middleware
  // enforces this at the edge; we re-check here as defense in depth.
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dry') === '1'
  const admin = createAdminClient()
  const today = new Date()

  // Past the final settlement date there is nothing left to chase for this
  // cycle, so the run stops here rather than reminding indefinitely.
  if (today > FINAL_SETTLEMENT) {
    return NextResponse.json({
      ok: true,
      dryRun,
      scanned: 0,
      remindersSent: 0,
      results: [],
      stopped: 'past final settlement date (31 Aug 2026)',
    })
  }

  const { data: apps, error } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, preferred_booth_tier, special_requirements, status, reviewed_at')
    .eq('status', 'approved')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<Record<string, unknown>> = []

  for (const app of apps || []) {
    const state = parsePortalState(app.admin_notes as string)
    if (state.payment?.status === 'paid') continue

    const reviewedAt = app.reviewed_at ? new Date(app.reviewed_at as string) : null
    if (!reviewedAt) continue
    const daysSinceApproval = daysBetween(reviewedAt, today)
    if (daysSinceApproval < 7) continue

    // Compute due date: approved_at + 30 days (organiser-set on approval).
    const dueDate = new Date(reviewedAt)
    dueDate.setDate(dueDate.getDate() + 30)
    // Overdue vendors keep getting reminded up to FINAL_SETTLEMENT (guarded
    // above). daysRemaining goes negative past the due date and the email
    // renders that as "N days overdue", which stays accurate.
    const daysRemaining = daysBetween(today, dueDate)

    // Already-fired reminders live under state.payment_reminders.history[].
    const history = ((state as unknown) as { payment_reminders?: { history?: { at: string; week: number }[] } }).payment_reminders?.history || []
    const lastSent = history.length ? new Date(history[history.length - 1].at) : null
    if (lastSent && daysBetween(lastSent, today) < 7) continue

    const weekNumber = Math.min(history.length + 1, 4)
    const pricing = computeVendorPricing({
      preferred_booth_tier: app.preferred_booth_tier as string,
      special_requirements: app.special_requirements,
    })
    const amount = state.payment?.amount ?? pricing.total
    const contactName = (app.contact_name as string) || 'there'
    const firstName = contactName.trim().split(/\s+/)[0] || contactName
    const businessName = (app.business_name as string) || 'your business'
    const dueDateStr = fmtDate(dueDate)

    const out: Record<string, unknown> = {
      id: app.id, business: businessName, week: weekNumber,
      amount, dueDate: dueDateStr, daysRemaining,
    }

    if (!dryRun) {
      // Email
      const emailRes = await sendEmail({
        to: app.email as string,
        subject: weekNumber >= 4
          ? `Final notice, stall fee overdue, ${businessName}`
          : `Reminder, your YAH Festival stall fee, ${businessName}`,
        react: VendorPaymentReminder({
          contactName,
          businessName,
          amount,
          dueDate: dueDateStr,
          daysRemaining,
          invoiceUrl: `${SITE}/exhibitor/portal/invoice`,
          payUrl: `${SITE}/exhibitor/portal/payments`,
          weekNumber,
        }),
      })
      out.emailSent = emailRes.ok

      // WhatsApp template: Meta-approved body, params: firstName, amount, dueDate
      const phone = (app.phone as string) || ''
      if (phone) {
        try {
          // Template body opens "Hi {{1}}," so param 1 is the person's first
          // name, not the business name (matches the email's greeting).
          const waRes = await sendTemplate(
            toE164(phone),
            'vendor_payment_reminder',
            [firstName, formatRand(amount), dueDateStr],
            { category: 'utility' }
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

      // Record send in portal_state
      await updatePortalState(app.id as string, (s) => {
        const cur = ((s as unknown) as { payment_reminders?: { history?: { at: string; week: number }[] } }).payment_reminders || {}
        const curHistory = cur.history || []
        return {
          ...s,
          payment_reminders: {
            ...cur,
            history: [...curHistory, { at: new Date().toISOString(), week: weekNumber }],
            due_date: dueDate.toISOString(),
          },
        } as typeof s
      })
    }

    results.push(out)
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    scanned: apps?.length ?? 0,
    remindersSent: results.length,
    results,
  })
}
