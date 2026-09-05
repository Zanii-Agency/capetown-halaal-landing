// Vendor payment PLANS: a vendor proposes exact-dated instalments over WhatsApp,
// the bot stores it, and a cron auto-approves it 5 minutes later and confirms to
// the vendor (Taona 2026-09-04, pure auto-approve, no operator veto; later dates
// allowed up to the festival). The wording is FIXED here, never model-written
// (dunning-cadence rule): the LLM only collects the dates/amounts and calls the
// tool; every vendor-facing sentence is a template below.
//
// Storage rides the existing payment.arrangement marker on admin_notes: `until`
// mirrors the LAST instalment date so the reminder/chase suppression already
// honours the whole plan (same field grant_payment_extension uses), plus the
// instalment list and a plan_status the cron flips from 'pending' to 'approved'.
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'
import { vendorBill } from '@/lib/payments/vendor-bill'
import { recordLedger } from '@/lib/zanii-ledger'

export interface Installment { date: string; amount: number }

// Hard SANITY cap, not a policy limit: the festival opens 12 Dec 2026, so a plan
// physically has to finish before the vendor trades. The operator allows dates
// past the old 31 Aug settlement, but not past the event itself.
export const PLAN_LAST_DATE = '2026-12-12'
const MIN_INSTALMENTS = 2
const MAX_INSTALMENTS = 6
const APPROVE_AFTER_MS = 5 * 60 * 1000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const todayISO = () => new Date().toISOString().slice(0, 10)
function fmt(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}
function rand(n: number): string { return `R${Math.round(n).toLocaleString('en-ZA')}` }
function planLines(plan: Installment[]): string {
  return plan.map((p, i) => `  ${i + 1}. ${rand(p.amount)} by ${fmt(p.date)}`).join('\n')
}

/** Validate a proposed plan against the outstanding fee. Correctness only (exact
 *  future dates in order, on/before the festival, amounts covering the full fee),
 *  never a business-policy gate. Returns a clean vendor-facing error string. */
export function validatePlan(
  installments: unknown,
  owing: number,
  todayStr: string = todayISO(),
): { ok: true; plan: Installment[] } | { ok: false; error: string } {
  if (!Array.isArray(installments) || installments.length < MIN_INSTALMENTS) {
    return { ok: false, error: `A payment plan needs at least ${MIN_INSTALMENTS} instalments, each with a date and an amount. Tell me the amount and exact date for each one.` }
  }
  if (installments.length > MAX_INSTALMENTS) {
    return { ok: false, error: `A payment plan can have at most ${MAX_INSTALMENTS} instalments. Please combine some into fewer, larger payments.` }
  }
  const plan: Installment[] = []
  for (const raw of installments) {
    const date = String((raw as { date?: unknown })?.date ?? '').trim()
    const amount = Number((raw as { amount?: unknown })?.amount)
    if (!DATE_RE.test(date) || isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      return { ok: false, error: `Each instalment needs a real date written as YYYY-MM-DD. "${date || '(missing)'}" is not one. What exact date will each payment be made?` }
    }
    if (!(amount > 0)) {
      return { ok: false, error: `Each instalment needs an amount greater than zero. How much will each payment be?` }
    }
    plan.push({ date, amount: Math.round(amount) })
  }
  const today = todayStr
  for (let i = 0; i < plan.length; i++) {
    if (plan[i].date <= today) {
      return { ok: false, error: `Every instalment must be a future date. ${fmt(plan[i].date)} is today or past, so please give a later date.` }
    }
    if (plan[i].date > PLAN_LAST_DATE) {
      return { ok: false, error: `Every instalment must be paid by ${fmt(PLAN_LAST_DATE)}, before the festival. ${fmt(plan[i].date)} is too late, please bring it earlier.` }
    }
    if (i > 0 && plan[i].date <= plan[i - 1].date) {
      return { ok: false, error: `The instalment dates need to be in order, each one later than the one before. Please put them in date order.` }
    }
  }
  const sum = plan.reduce((s, p) => s + p.amount, 0)
  if (sum < owing) {
    return { ok: false, error: `Your instalments add up to ${rand(sum)}, but your outstanding stall fee is ${rand(owing)}. The plan has to cover the full amount, so please raise the instalments to total at least ${rand(owing)}.` }
  }
  return { ok: true, plan }
}

/** Called by the bot tool. Loads the vendor, validates, and stores the plan as
 *  PENDING; the 5-minute cron approves it. Returns the vendor-facing reply. */
export async function proposePaymentPlan(vendorId: string, installments: unknown): Promise<string> {
  const admin = createAdminClient()
  const { data: row } = await admin
    .from('vendor_applications')
    .select('id, business_name, admin_notes, paid_at, preferred_booth_tier, special_requirements')
    .eq('id', vendorId)
    .maybeSingle()
  if (!row) return 'I could not load your account just now. Please try again shortly.'

  const st = parsePortalState(row.admin_notes as string)
  if (st.payment?.status === 'paid' || st.payment?.status === 'collected') {
    return 'Your stall fee is already settled, thank you, so there is nothing to set up a plan for.'
  }

  const bill = vendorBill({
    id: vendorId,
    preferred_booth_tier: (row.preferred_booth_tier as string) || null,
    special_requirements: row.special_requirements,
    admin_notes: row.admin_notes as string,
    paid_at: row.paid_at as string | null,
  })
  const owing = Math.max(0, Math.round(bill.owing))
  if (owing <= 0) return 'There is nothing outstanding on your account right now, so a payment plan is not needed.'

  const v = validatePlan(installments, owing)
  if (!v.ok) return v.error

  const now = new Date().toISOString()
  const last = v.plan[v.plan.length - 1].date
  await updatePortalState(vendorId, (s) => ({
    ...s,
    payment: {
      ...s.payment,
      status: 'deferred',
      arrangement: {
        until: last,
        agreed_at: now,
        note: 'payment plan proposed via WhatsApp',
        installments: v.plan,
        proposed_at: now,
        plan_status: 'pending',
      },
    },
  }))

  // Master heads-up (finance concern, walled from the festival owner). The
  // operator chose no veto, but still sees every plan and can intervene by hand.
  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({
      event: 'system_alert',
      audience: 'master',
      body: `PAYMENT PLAN proposed by ${row.business_name || 'a vendor'} via WhatsApp (auto-approves in 5 min):\n${planLines(v.plan)}\nOutstanding: ${rand(owing)}.`,
    })
  } catch (e) { console.error('[payment-plan] master notify failed:', (e as Error).message) }

  await recordLedger('payments', 'cth.pay.plan_proposed', { application_id: vendorId, installments: v.plan, owing }).catch(() => {})

  return planSubmittedMsg(v.plan)
}

/** Cron worker: approve every pending plan that is at least 5 minutes old, and
 *  confirm to the vendor. Returns a summary for the route to log. */
export async function approveDuePaymentPlans(): Promise<{ approved: number; confirmed: number; errors: string[] }> {
  const admin = createAdminClient()
  const cutoff = Date.now() - APPROVE_AFTER_MS
  const errors: string[] = []
  let approved = 0
  let confirmed = 0

  // Paginate (PostgREST caps un-paginated reads ~1000).
  const rows: Array<{ id: string; business_name: string | null; phone: string | null; admin_notes: string | null }> = []
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from('vendor_applications')
      .select('id, business_name, phone, admin_notes')
      .range(from, from + 999)
    if (!data?.length) break
    rows.push(...(data as typeof rows))
    if (data.length < 1000) break
  }

  for (const r of rows) {
    const arr = parsePortalState(r.admin_notes).payment?.arrangement
    if (!arr?.installments?.length || arr.plan_status !== 'pending' || !arr.proposed_at) continue
    if (new Date(arr.proposed_at).getTime() > cutoff) continue // not yet 5 minutes old

    try {
      // updatePortalState reads the CURRENT admin_notes inside itself, so a second
      // cron run (or any run after this plan was already approved) re-reads
      // 'approved' and the mutator no-ops. `flipped` tells us whether THIS run is
      // the one that moved pending -> approved, so only it confirms to the vendor
      // and alerts the master. This stops a double confirmation on an overlapping
      // run without a table lock (residual ms-window race is negligible at ~238 rows).
      let flipped = false
      await updatePortalState(r.id, (s) => {
        const a = s.payment?.arrangement
        if (!a || a.plan_status !== 'pending') return s // already approved elsewhere
        flipped = true
        return { ...s, payment: { ...s.payment, arrangement: { ...a, plan_status: 'approved', approved_at: new Date().toISOString() } } }
      })
      if (!flipped) continue
      approved++
      await recordLedger('payments', 'cth.pay.plan_approved', { application_id: r.id, installments: arr.installments }).catch(() => {})

      if (r.phone) {
        const sent = await sendPlanApproval(r.phone, arr.installments as Installment[])
        if (sent) confirmed++
        else errors.push(`confirm ${r.business_name || r.id}: not delivered`)
      }
      try {
        const { notifyOwners } = await import('@/lib/bot/notify')
        await notifyOwners({ event: 'system_alert', audience: 'master', body: `PAYMENT PLAN auto-approved for ${r.business_name || r.id}:\n${planLines(arr.installments as Installment[])}` })
      } catch { /* best-effort */ }
    } catch (e) {
      errors.push(`${r.business_name || r.id}: ${(e as Error).message}`)
    }
  }
  return { approved, confirmed, errors }
}

async function sendPlanApproval(phone: string, plan: Installment[]): Promise<boolean> {
  const { sendText, toE164 } = await import('@/lib/whatsapp')
  const { windowOpenFor } = await import('@/lib/wa-window')
  const e164 = toE164(phone)
  try {
    // A vendor who proposed a plan 5 to 7 minutes ago is inside their 24h window,
    // so this free-text send is the real path. If the window is somehow shut we do
    // NOT fall back to festival_announcement (Meta drops it as marketing, 131049) —
    // we return false, and the master alert fired on approval flags that the
    // confirmation did not reach them so a human can follow up.
    if (!(await windowOpenFor(e164))) return false
    const r = await sendText(e164, planApprovedMsg(plan))
    return !r.skipped
  } catch (e) {
    console.error('[payment-plan] confirm send failed:', (e as Error).message)
    return false
  }
}

// ---- Fixed vendor-facing copy (no em-dashes, Law 7). ----

export function planSubmittedMsg(plan: Installment[]): string {
  return `Thank you. I have submitted your payment plan for approval:\n${planLines(plan)}\nYou will get a confirmation here shortly, and your spot stays reserved in the meantime.`
}

export function planApprovedMsg(plan: Installment[]): string {
  return `Good news, your payment plan is approved:\n${planLines(plan)}\nPlease pay each instalment through Payments in your portal by its date. Your spot stays reserved as long as you keep to the plan. Send your proof of payment to support@youngatheart.co.za after each one.`
}
