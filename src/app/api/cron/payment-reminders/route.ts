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
//        - The vendor's payment_due_date hasn't passed by more than 14 days
//          (a soft grace period; after that the spot is released and we stop
//          spamming them).
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
    const daysRemaining = daysBetween(today, dueDate)
    if (daysRemaining < -14) continue // grace period exhausted, stop spamming

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
