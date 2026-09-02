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
import { parsePortalState, updatePortalState, hasPaid, isWithdrawn, getArrangement } from '@/lib/portal-state'
import { buildSuppressedPeople, newSendDeduper } from '@/lib/payments/chase-targeting'
import { reminderWaBody, segFromWeek } from '@/lib/payments/reminder-copy'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { sendEmail } from '@/lib/email/resend'
import { VendorPaymentReminder } from '@/lib/email/templates/VendorPaymentReminder'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { isTestVendor } from '@/lib/test-vendors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SITE = 'https://cthalaal.co.za'

// Reminders run until this cutoff, then stop (nothing left to chase for the cycle).
// EXTENDED 2026-09-01: was 2026-08-31, a payment-concession date that silently
// killed ALL chasing the moment it passed, even though the festival is 11-13 Dec
// 2026 and 100+ vendors are still unpaid. Set to the festival start so the bot keeps
// hunting for payment + proof right up to the event (Taona: "make sure the bot is
// actively hunting for proof of payment"). Per-vendor due dates and the on-request
// settlement concession are unchanged; move this earlier for a hard "pay or lose
// your spot" deadline before the festival.
const FINAL_SETTLEMENT = new Date('2026-12-11T21:59:59.999Z')

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

  // Person-level suppression: a paid/deferred row on a person's OTHER approved
  // application (a duplicate submission) must suppress ALL their rows. The
  // per-row isChaseSuppressed inside the loop only sees one row, so a paid
  // vendor with an empty twin row was chased on the shared phone (Melonscape,
  // Chocotag, 2026-08-10). Built once from the full fetch.
  const suppressed = buildSuppressedPeople((apps || []) as never[], today)
  // A person with two unpaid rows must be messaged at most once per run.
  const deduper = newSendDeduper()

  const results: Array<Record<string, unknown>> = []
  // Vendors skipped because they are on the master EFT lane. Reported so the
  // exclusion is observable in the run output, not silent.
  let laneExcluded = 0

  for (const app of apps || []) {
    // Seed rows are never billed: a reminder to a demo vendor is a real email
    // out of the CTH account and a real billed WhatsApp template.
    if (isTestVendor(app)) continue
    const state = parsePortalState(app.admin_notes as string)
    // HARD skip (silent): paid/collected/waived or withdrawn, on this row OR on
    // any other row for the same person (a duplicate submission). The old
    // per-row test chased a paid vendor's empty twin on the shared phone
    // (Melonscape, Chocotag, 2026-08-10).
    if (hasPaid(state) || isWithdrawn(state)) continue
    if (suppressed.hardHas(app as never)) continue
    // MASTER EFT LANE (Taona 2026-09-02): a lane vendor shows unpaid to Samreen
    // but is being handled personally by the EFT admin, so the generic "please
    // pay" reminder must never reach them. They are chased from the EFT Outreach
    // tab instead. Person-level, so a lane vendor's twin row is excluded too.
    if (suppressed.laneHas(app as never)) { laneExcluded++; continue }

    // An in-force extension does NOT silence the vendor: they still get a
    // GENTLE, extension-aware reminder that acknowledges the new date and asks
    // them to pay by it (operator, 2026-08-10). Resolved per-row or per-person.
    const arrangement = getArrangement(state, today) || suppressed.arrangementFor(app as never)

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

    // This row is chaseable. Claim the person so a second unpaid row for the
    // same phone/email does not send them a second reminder this run.
    if (!deduper.claim(app as never)) continue

    const weekNumber = Math.min(history.length + 1, 4)
    // Extension holders never escalate to a "final notice", however many
    // reminders have fired: their reminder stays gentle and acknowledges the date.
    const effectiveWeek = arrangement ? 1 : weekNumber
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
      // Email (tone follows effectiveWeek: extension holders stay gentle).
      const emailRes = await sendEmail({
        to: app.email as string,
        subject: effectiveWeek >= 4
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
          weekNumber: effectiveWeek,
        }),
      })
      out.emailSent = emailRes.ok

      // WhatsApp: free-form body via festival_announcement ("Hi {{1}}! {{2}}").
      // Overdue-aware, extension-aware, pushes to the portal, names no payment
      // method, no double-R. Replaces the fixed vendor_payment_reminder that
      // sent "RR6 400 due on <past date>".
      const waBody = reminderWaBody({
        amount,
        due: dueDate,
        daysRemaining,
        seg: segFromWeek(effectiveWeek),
        arrangementUntil: arrangement?.until ?? null,
      })
      out.waBody = waBody
      const phone = (app.phone as string) || ''
      if (phone) {
        try {
          const waRes = await sendTemplate(
            toE164(phone),
            'festival_announcement',
            [firstName, waBody],
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
    laneExcluded,
    results,
  })
}
