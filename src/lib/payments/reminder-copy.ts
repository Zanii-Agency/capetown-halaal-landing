// Shared WhatsApp reminder body for the payment-reminder cron.
//
// Sent as festival_announcement {{2}} (renders after "Hi {{1}}! "), so it must
// NOT start with "Hi" and must be a complete free-form sentence. Rules:
//   - Never name a payment method (EFT/Yoco/bank) — operator rule 2026-07-24.
//   - Always push to the portal for the live figure (operator: "they should
//     always log in and see what is going on, push them to the portal").
//   - Overdue vendors are told HOW overdue + the waiting-list consequence,
//     never a soft "friendly reminder" of a date already in the past.
//   - Extension holders get an acknowledgement of the new date + a nudge to
//     pay by it, never a "final notice".
//   - No em-dashes (CTH-DOCTRINE Law 7).
//
// Replaces the fixed Meta template `vendor_payment_reminder`, whose body was
// "...stall fee of R{{2}}..." fed a formatRand() value ("R6 400") → "RR6 400",
// and which could not express overdue/extension state.

import { formatRand } from './pricing'

const PORTAL_URL = 'https://cthalaal.co.za/exhibitor/portal/payments'

export type ReminderSeg = 'intro' | 'nudge' | 'firm'

/** Reminder tone from how many reminders have already fired (week counter). */
export function segFromWeek(week: number): ReminderSeg {
  if (week <= 1) return 'intro'
  if (week <= 3) return 'nudge'
  return 'firm'
}

export interface ReminderCopyInput {
  amount: number
  due: Date
  daysRemaining: number // negative => overdue
  seg: ReminderSeg
  /** In-force extension date (YYYY-MM-DD) if the vendor was granted more time. */
  arrangementUntil?: string | null
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
}
const dayWord = (n: number) => `${n} day${n === 1 ? '' : 's'}`

export function reminderWaBody(i: ReminderCopyInput): string {
  const amt = formatRand(i.amount)
  const overdue = i.daysRemaining < 0
  const portal = `Log in to your portal to view and settle it: ${PORTAL_URL}`

  // Extension in force: acknowledge the new date, advise to pay by it, never firm.
  if (i.arrangementUntil) {
    const until = fmtDate(new Date(`${i.arrangementUntil}T00:00:00`))
    return overdue
      ? `Your stall fee of ${amt} for Young at Heart is overdue, and you have been given until ${until} to settle it in full. Please pay by then to keep your spot. ${portal}`
      : `Your stall fee of ${amt} for Young at Heart is due, and you have been given until ${until} to settle it in full. ${portal}`
  }

  // Not yet due: gentle, correct date, portal push.
  if (!overdue) {
    return `Your stall fee of ${amt} for Young at Heart is due on ${fmtDate(i.due)}. ${portal}`
  }

  // Overdue: how overdue + waiting-list consequence + portal.
  const lead = i.seg === 'firm' ? 'This is a final notice. ' : ''
  return `${lead}Your stall fee of ${amt} for Young at Heart is now ${dayWord(Math.abs(i.daysRemaining))} overdue. Spots are being released to the waiting list as fees come in, so please settle now to keep yours. ${portal}`
}
