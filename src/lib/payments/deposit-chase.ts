// Deposit chase (Taona 2026-10-14). Every plan / hold agreed from RULE_START has
// its deposit (the first instalment) due 2 days after agreement. If no deposit
// money AND no uploaded proof: a daily reminder on days 3 to 6, a final notice on
// day 7 (stall at risk, 24 hours), then on day 8 one alert into the support inbox
// for the team to decide on removal. Nothing is ever removed automatically.
// Wording is fixed here, never model-written. No dashes (Law 7).

export const RULE_START = '2026-10-14'
export const CHASE_END = '2026-11-14'

export type DepositStage = 'reminder' | 'final' | 'alert'

/** Whole days from the agreement date to today (both YYYY-MM-DD). */
export function daysSince(agreedISO: string, todayISO: string): number {
  return Math.round((Date.parse(`${todayISO}T00:00:00Z`) - Date.parse(`${agreedISO}T00:00:00Z`)) / 86_400_000)
}

/** Which message (if any) is due today. Pure. */
export function depositStage(agreedISO: string, todayISO: string): DepositStage | null {
  const d = daysSince(agreedISO, todayISO)
  if (d >= 3 && d <= 6) return 'reminder'
  if (d === 7) return 'final'
  if (d >= 8) return 'alert' // sent once; idempotency is the caller's stamp
  return null
}

function fmt(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}
const rand = (n: number) => `R${Math.round(n).toLocaleString('en-ZA')}`
const UPLOAD = 'upload your proof of payment in your exhibitor portal (Payments, upload proof of payment)'

export function reminderText(amount: number, dueISO: string): string {
  return `A quick reminder that your deposit of ${rand(amount)} for your Young at Heart stall was due on ${fmt(dueISO)}. Please make the payment and ${UPLOAD} so we can confirm your plan.`
}

export function finalText(amount: number): string {
  return `We have not yet received your deposit of ${rand(amount)}. You have been accepted as a vendor and we have vendors on the waiting list, so your stall is now at risk. Please pay the deposit and ${UPLOAD} within 24 hours to keep your stall.`
}

export function alertText(business: string, amount: number, dueISO: string): string {
  return `${business} has not paid their deposit of ${rand(amount)} (due ${fmt(dueISO)}) despite daily reminders and a final notice. Please check this vendor and decide whether to remove them.`
}
