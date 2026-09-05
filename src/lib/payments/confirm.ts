// Single source of truth for marking a vendor payment as paid. Used by both
// the Yoco webhook (when the gateway confirms) and the admin "mark as paid"
// action (when an organiser reconciles an EFT/cash payment manually).
//
// Idempotent: re-running with the same applicationId is a no-op for emails
// and template messages (it never sends twice).

import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState, updatePortalStateImpl, type PortalState } from '@/lib/portal-state'
import { withOwnerCutoff } from '@/lib/owner-view'
import { earliestEftTimestamp, hasEftMarker } from '@/lib/eft'
import { sendEmail } from '@/lib/email/resend'
import { VendorPaymentConfirmation } from '@/lib/email/templates/VendorPaymentConfirmation'
import { computeVendorPricing, formatRand } from '@/lib/payments/pricing'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { findWaTemplate, buildWaTemplateParams } from '@/lib/templates/wa-meta'
import { recordLedger } from '@/lib/zanii-ledger'
import { paymentReference } from '@/lib/payments'

const SITE = 'https://cthalaal.co.za'

/** 'samreen_eft' = an EFT into the festival owner's reconciled account (...629),
 *  confirmed by HER on /admin/eft-proofs. It is her money exactly like Yoco, so it
 *  is NOT a master-only method: until 2026-09-05 the confirm route wrote 'eft',
 *  which MASTER_ONLY_METHODS treats as covert, and every vendor she confirmed
 *  vanished from her own finance dashboard, roster scope and inbox. */
export type PaymentMethod = 'yoco' | 'eft' | 'samreen_eft' | 'cash' | 'manual_card' | 'waived'

/** Every payment method, so a new one cannot be added without the audience test
 *  below forcing a decision about who sees its alert. */
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['yoco', 'eft', 'samreen_eft', 'cash', 'manual_card', 'waived']

/** Who sees a payment alert. Routes on the METHOD, not the EFT lane (Taona
 *  2026-07-26: "payment captured from yoco is always her but never eft").
 *
 *  The lane is the wrong discriminator here: confirmPayment writes paid_at before
 *  notifying, so the vendor is out of the lane by definition by the time the alert
 *  fires. Body text is also wrong — the top-up branch renders "paid an ADDITIONAL
 *  R…" and never names the method, so mentionsEft would miss an EFT top-up.
 *  The method is the fact; everything else is a proxy for it. */
export function paymentAlertAudience(method: PaymentMethod): 'all' | 'master' {
  // manual_card joins eft on the master lane (Taona 2026-07-26): both are
  // operator-entered settlements of a payment taken outside Yoco, so they carry
  // the same off-gateway handling the owner is walled off from. yoco, cash,
  // waived and samreen_eft (her own reconciled EFT account) are hers.
  return method === 'eft' || method === 'manual_card' ? 'master' : 'all'
}

export interface ConfirmPaymentInput {
  applicationId: string
  method: PaymentMethod
  amount?: number          // optional override; falls back to pricing.total
  providerRef?: string     // gateway txn id, EFT slip reference, "cash @ door", etc
  notes?: string           // admin-only note appended to admin_notes (not state)
  /** When true, skip outbound email + WhatsApp (useful for backfill / corrections). */
  silent?: boolean
  /** When false, skip the VENDOR email + WhatsApp but STILL notify the owner. Used
   *  by the EFT→Yoco settlement path: the vendor was already acknowledged at the
   *  'collected' stage, so settling via Yoco should update the owner + finance
   *  numbers without pinging the vendor again. Defaults to true. */
  notifyVendor?: boolean
}

export interface ConfirmPaymentResult {
  ok: boolean
  alreadyPaid: boolean
  amount: number
  error?: string
}

/**
 * Send (or re-send) the vendor payment confirmation email using the same
 * template + invoice link the original confirmation used. Called by
 * confirmPayment() on first success and by /api/admin/payments/resend-invoice
 * when an organiser triggers a resend. Returns { sent } so callers can show a
 * truthful real-time toast.
 */
export async function sendVendorPaymentEmail(args: {
  to: string
  contactName: string
  businessName: string
  amount: number
  providerRef: string
  reference?: string
  paidDate?: string
  pricing?: import('@/lib/payments/pricing').VendorPricing
}): Promise<{ sent: boolean; error?: string }> {
  // No PDF attachment by design. Invoice PDFs from a first-touch sender are the
  // dominant Gmail/Outlook spam signal (phishing pattern). The full itemised
  // receipt is rendered inline in the email body and the printable copy lives
  // behind auth at /exhibitor/portal/invoice. See knowledge-tree node on
  // attachment-vs-link deliverability.
  try {
    const invoiceUrl = `${SITE}/exhibitor/portal/invoice`
    const portalUrl = `${SITE}/exhibitor/login`
    await sendEmail({
      to: args.to,
      subject: `Payment confirmed, ${args.businessName}, Young at Heart Festival 2026`,
      react: VendorPaymentConfirmation({
        contactName: args.contactName,
        businessName: args.businessName,
        amount: args.amount,
        providerRef: args.providerRef,
        reference: args.reference,
        paidDate: args.paidDate,
        pricing: args.pricing,
        invoiceUrl,
        portalUrl,
      }),
      text: [
        `Hi ${args.contactName},`,
        '',
        `We've received your payment of ${formatRand(args.amount)} for ${args.businessName}. Your trading spot at Young at Heart Festival 2026 is confirmed.`,
        '',
        `Reference: ${args.providerRef || 'manual'}`,
        `Paid: ${args.paidDate || 'today'}`,
        '',
        `View and download your printable invoice from your portal:`,
        invoiceUrl,
        '',
        `Log in here:`,
        portalUrl,
        '',
        `Welcome to the family.`,
        `The Young at Heart Festival Team`,
      ].join('\n'),
    })
    return { sent: true }
  } catch (e) {
    const msg = (e as Error).message
    console.error('[sendVendorPaymentEmail] failed:', msg)
    return { sent: false, error: msg }
  }
}

/** Send the vendor WhatsApp payment confirmation (`vendor_payment_confirmation`),
 *  routed through the wa-meta registry guard so a missing/invalid template fails
 *  observably (logged + a `failed` wa_messages row) rather than silently. Extracted
 *  so both confirmPayment() and the EFT 'collected' acknowledgment reuse ONE path.
 *  Best-effort: never throws. */
export async function sendVendorPaymentWa(args: {
  admin: ReturnType<typeof createAdminClient>
  waPhone: string
  firstName: string
  amount: number
  stallLabel: string
}): Promise<void> {
  const TEMPLATE_KEY = 'vendor_payment_confirmation'
  const { admin, waPhone } = args
  if (!waPhone) return
  const waTo = toE164(waPhone)
  const previewBody = `[${TEMPLATE_KEY}] Payment received, ${args.firstName}. Amount: ${formatRand(args.amount)}, Stall: ${args.stallLabel}`
  const logFail = (err: string) =>
    admin.from('wa_messages').insert({ direction: 'out', wa_phone: waTo, body: previewBody, status: 'failed', provider_message_id: null, error: err })
  try {
    const spec = findWaTemplate(TEMPLATE_KEY)
    if (!spec) {
      const err = `wa template not registered: ${TEMPLATE_KEY}`
      console.error(`[sendVendorPaymentWa] skipped: ${err}`)
      await logFail(err)
      return
    }
    const built = buildWaTemplateParams(spec, {
      first_name: args.firstName,
      amount: formatRand(args.amount),
      stall_label: args.stallLabel,
    })
    if (!built.ok) {
      const err = `wa template params invalid (${TEMPLATE_KEY}): ${built.error}`
      console.error(`[sendVendorPaymentWa] skipped: ${err}`)
      await logFail(err)
      return
    }
    const res = await sendTemplate(waTo, TEMPLATE_KEY, built.ordered, { category: spec.category })
    // On success sendTemplate ALREADY logged the rendered body to wa_messages
    // (whatsapp.ts logWhatsAppOutbound), so a second insert here was a duplicate
    // inbox bubble (Kgotsos, Melonscape, Chocotag showed two "Payment received"
    // rows at one timestamp, 2026-08-10). Only log the SKIP case, which
    // sendTemplate returns before it logs anything.
    if (res.skipped) {
      console.error(`[sendVendorPaymentWa] not sent (${TEMPLATE_KEY}): ${res.skipped}`)
      await logFail(res.skipped)
    }
  } catch (e) {
    console.error('[sendVendorPaymentWa] failed:', (e as Error).message)
  }
}

/**
 * TEMPORARY EFT lane. Mark a vendor's EFT payment as COLLECTED (interim): the
 * vendor sees PAID and gets an acknowledgment, but `paid_at` stays NULL and the
 * payment is NOT counted in finance totals until it is settled through Yoco. Does
 * NOT notify the owner (that happens at Yoco settlement). Idempotent-ish: safe to
 * re-run; it just re-stamps collected + re-sends the acknowledgment.
 */
export async function markEftCollected(applicationId: string, amountOverride?: number): Promise<{ ok: boolean; amount: number; error?: string }> {
  const admin = createAdminClient()
  const { data: app, error } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, special_requirements, preferred_booth_tier')
    .eq('id', applicationId)
    .maybeSingle()
  if (error || !app) return { ok: false, amount: 0, error: error?.message || 'application not found' }

  const before = parsePortalState(app.admin_notes as string)
  if (before.payment?.status === 'paid' || before.payment?.paid_at) {
    return { ok: false, amount: 0, error: 'already paid (settle via Yoco, not collect)' }
  }
  const pricing = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
  })
  const paidBefore = Number(before.payment?.amount) || 0
  const amount = amountOverride ?? Math.max(0, pricing.total - paidBefore)
  const collectedAtIso = new Date().toISOString()

  await updatePortalState(applicationId, (s) => ({
    ...s,
    payment: {
      ...(s.payment || {}),
      status: 'collected',            // interim: vendor sees paid, NOT counted in finance
      amount,
      eft_collected_at: s.payment?.eft_collected_at || collectedAtIso,
      // deliberately NO paid_at and NO method — settlement via Yoco sets those.
    },
  }))

  const contactName = (app.contact_name as string) || 'there'
  const firstName = contactName.trim().split(/\s+/)[0] || contactName
  const businessName = (app.business_name as string) || 'your business'
  const paidDate = new Date(collectedAtIso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })

  // Vendor acknowledgment ONLY (owner is not pinged at collect). Methodless copy.
  await sendVendorPaymentEmail({
    to: app.email as string,
    contactName,
    businessName,
    amount,
    providerRef: '',
    reference: before.payment?.reference || applicationId.slice(0, 8).toUpperCase(),
    paidDate,
    pricing,
  })
  await sendVendorPaymentWa({ admin, waPhone: (app.phone as string) || '', firstName, amount, stallLabel: pricing.stallLabel })

  return { ok: true, amount }
}

/**
 * PRESENT an EFT-collected payment to the festival owner as a clean "paid via
 * Yoco" entry (Samreen's request: she knows about the EFT lane but the interim
 * collected state makes her accounting harder, so she wants one solid paid+Yoco
 * view). Reaches the REAL paid-Yoco state through the single settlement authority
 * confirmPayment(method:'yoco'), so the owner-visibility wall is UNCHANGED and the
 * money counts EXACTLY ONCE (the paid_at IS NULL guard). confirmPayment auto-stamps
 * ⟦OWNERCUT⟧, hiding the EFT-era conversation from her, exactly as every real
 * EFT->Yoco settlement does. The vendor is NOT re-notified (acknowledged at
 * collect); the owner IS (she learns it is paid) unless notifyOwner is false.
 *
 * Honest by construction: we set the human `reference` (YAH-…) she reconciles
 * against, but NEVER a fabricated Yoco `provider_ref` — no fake gateway txn is
 * claimed, and the EFT evidence stays intact on the EFT console for the operator.
 * "Settle later" is a SEPARATE operator-only tracking flag (markEftReconciled)
 * that does nothing to the owner, who already sees paid.
 */
export async function presentEftAsPaid(
  applicationId: string,
  opts?: { notifyOwner?: boolean },
): Promise<{ ok: boolean; amount: number; reference: string; error?: string }> {
  const admin = createAdminClient()
  const { data: app } = await admin
    .from('vendor_applications')
    .select('id, admin_notes')
    .eq('id', applicationId)
    .maybeSingle()
  if (!app) return { ok: false, amount: 0, reference: '', error: 'application not found' }

  const p = parsePortalState(app.admin_notes as string).payment
  // Only a COLLECTED (EFT money in, interim) vendor can be presented: a truly
  // paid vendor is already visible to her, and an un-collected one has no money in.
  if (p?.status !== 'collected') {
    return { ok: false, amount: 0, reference: '', error: p?.status === 'paid' ? 'already paid' : 'not collected (mark collected first)' }
  }
  const amount = Number(p?.amount) || 0
  const reference = paymentReference(applicationId)

  const res = await confirmPayment({
    applicationId,
    method: 'yoco',
    amount,
    notifyVendor: false,            // vendor was already acknowledged at 'collected'
    silent: opts?.notifyOwner === false,
  })
  if (!res.ok) return { ok: false, amount, reference, error: res.error || 'confirm failed' }

  // Persist the owner-facing reference + the present marker. Deliberately NO
  // provider_ref: the YAH- reference is an honest bank reference, not a claim of
  // a Yoco API transaction that never happened.
  await updatePortalState(applicationId, (s) => ({
    ...s,
    payment: {
      ...(s.payment || {}),
      reference,
      presented_eft: { at: new Date().toISOString(), reference },
    },
  }))
  return { ok: true, amount, reference }
}

/**
 * Operator-only "settle later" tracking for a presented EFT payment: stamps that
 * the operator has reconciled the actual EFT money on their side. PURE bookkeeping
 * — the owner already sees paid, so this changes nothing for her and nothing in
 * finance. Reuses the stored YAH- reference.
 */
export async function markEftReconciled(applicationId: string): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient()
  const { data: app } = await admin
    .from('vendor_applications')
    .select('id, admin_notes')
    .eq('id', applicationId)
    .maybeSingle()
  if (!app) return { ok: false, error: 'application not found' }
  if (!parsePortalState(app.admin_notes as string).payment?.presented_eft) {
    return { ok: false, error: 'not a presented EFT payment' }
  }
  await updatePortalState(applicationId, (s) => ({
    ...s,
    payment: { ...(s.payment || {}), reconciled_at: new Date().toISOString() },
  }))
  return { ok: true }
}

/**
 * Split-bill ACCESSORY collect (2026-08-04). The vendor's STALL fee is already
 * settled; this confirms their accessory-electricity EFT landed. Mirrors the
 * stall two-state: writes payment.acc { amount, collected_at } so the vendor's
 * bill shows accessories PAID and they get the same methodless acknowledgment,
 * but payment.amount (what finance counts) is untouched until the accessory
 * Yoco settlement folds it in via the webhook top-up path — so revenue counts
 * exactly once. Owner is NOT pinged (EFT stays master-only). Re-runnable.
 */
export async function markAccessoriesCollected(applicationId: string, amountOverride?: number): Promise<{ ok: boolean; amount: number; error?: string }> {
  const admin = createAdminClient()
  const { data: app, error } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, special_requirements, preferred_booth_tier, paid_at')
    .eq('id', applicationId)
    .maybeSingle()
  if (error || !app) return { ok: false, amount: 0, error: error?.message || 'application not found' }

  const { vendorBill } = await import('@/lib/payments/vendor-bill')
  const bill = vendorBill({
    id: applicationId,
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
    admin_notes: app.admin_notes as string | null,
    paid_at: app.paid_at as string | null,
  })
  if (!bill.settled) return { ok: false, amount: 0, error: 'stall fee not settled yet: collect the stall EFT first (this is the accessory flow)' }
  if (bill.acc?.collected_at && !bill.acc?.settled_at) {
    return { ok: false, amount: Number(bill.acc.amount) || 0, error: 'accessories already collected (settle via Yoco next)' }
  }
  const amount = amountOverride ?? bill.accessories.owing
  if (!amount || amount <= 0) return { ok: false, amount: 0, error: 'no accessory balance owing' }

  const collectedAtIso = new Date().toISOString()
  await updatePortalState(applicationId, (s) => ({
    ...s,
    payment: {
      ...(s.payment || {}),
      acc: { ...(s.payment?.acc || {}), amount, collected_at: collectedAtIso },
    },
  }))

  const contactName = (app.contact_name as string) || 'there'
  const firstName = contactName.trim().split(/\s+/)[0] || contactName
  const businessName = (app.business_name as string) || 'your business'
  const paidDate = new Date(collectedAtIso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })

  // Vendor acknowledgment ONLY (owner is not pinged). NOT the stall payment
  // confirmation template: that one says "your trading spot is confirmed",
  // which is false-in-a-way-that-matters for a R400 accessory collect (their
  // spot was confirmed when the stall fee settled). Purpose-written copy that
  // names the accessory electricity and their -ACC reference instead.
  const { accEftReference } = await import('@/lib/payments/vendor-bill')
  const accRef = accEftReference({ id: applicationId, admin_notes: app.admin_notes as string | null, business_name: app.business_name as string | null })
  try {
    await sendEmail({
      to: app.email as string,
      subject: `Accessory electricity payment received, ${businessName}`,
      text: [
        `Hi ${contactName},`,
        '',
        `We've received your payment of ${formatRand(amount)} for the accessory electricity at your ${businessName} stall. This covers the appliances you booked on your application.`,
        '',
        `Reference: ${accRef}`,
        `Received: ${paidDate}`,
        '',
        `Your stall fee was already settled, so there is nothing else to do. Your Payments page now shows your accessories as paid.`,
        '',
        `The Young at Heart Festival Team`,
      ].join('\n'),
    })
  } catch (e) {
    console.error('[markAccessoriesCollected] vendor email failed:', (e as Error).message)
  }
  // WhatsApp ack via the registered payment-confirmation template (the only
  // approved template with an amount slot). Its copy is amount-first and
  // method-free, so it reads correctly for an accessory amount too.
  await sendVendorPaymentWa({ admin, waPhone: (app.phone as string) || '', firstName, amount, stallLabel: bill.stall.label })

  return { ok: true, amount }
}

export async function confirmPayment(input: ConfirmPaymentInput): Promise<ConfirmPaymentResult> {
  const admin = createAdminClient()
  const { data: app, error: appErr } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, special_requirements, preferred_booth_tier')
    .eq('id', input.applicationId)
    .maybeSingle()

  if (appErr) {
    console.error('[confirmPayment] lookup failed:', appErr.message)
    return { ok: false, alreadyPaid: false, amount: 0, error: `lookup: ${appErr.message}` }
  }
  if (!app) return { ok: false, alreadyPaid: false, amount: 0, error: 'application not found' }

  const before = parsePortalState(app.admin_notes as string)
  const amountPaidBefore = Number(before.payment?.amount) || 0
  const beforeRefs: string[] = Array.isArray((before.payment as { refs?: unknown } | undefined)?.refs)
    ? ((before.payment as { refs?: string[] }).refs as string[])
    : []
  // Already settled in a PRIOR confirmed call? Gates top-ups (a top-up only
  // happens after a first payment has landed).
  const wasPaidBefore = before.payment?.status === 'paid' || !!before.payment?.paid_at

  const pricing = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
  })
  // What THIS payment settles: the explicit charged amount (Yoco/admin), else
  // the current outstanding balance (live total minus what is already paid).
  const outstandingBefore = Math.max(0, pricing.total - amountPaidBefore)
  const amount = input.amount ?? outstandingBefore
  const ref = input.providerRef || ''
  const isDuplicateRef = !!ref && (beforeRefs.includes(ref) || before.payment?.provider_ref === ref)

  const paidAtIso = new Date().toISOString()

  // Atomic transition authority. This guarded UPDATE is the SINGLE point that
  // decides whether THIS call is the one that moved the row unpaid -> paid.
  // It only touches a row where paid_at IS NULL, and .select() returns the
  // rows it actually wrote. Under Yoco retry / concurrent webhook delivery,
  // exactly one call matches the unpaid row and gets a returned row back; every
  // other concurrent/retried call matches 0 rows and gets an empty array. We
  // run this BEFORE the side-effects and gate every send on its result, so a
  // duplicate webhook can never re-send the confirmation email/WhatsApp/owner
  // notify. The non-atomic `alreadyPaid` read above is no longer load-bearing
  // for the send decision (it stays only as a returned-result hint to callers).
  //
  // Idempotent: only writes when paid_at IS NULL (first transition into paid).
  // paid_at is the ONLY real top-level payment column on this table (there is
  // no payment_status / payment_amount column in the CTH Supabase, verified
  // against information_schema). The richer payment detail (status, amount,
  // provider_ref) lives in the ⟦PORTAL⟧ marker on admin_notes, mirrored just
  // below. Writing a phantom payment_status here previously errored the whole
  // UPDATE, so paid_at never persisted AND wonTransition was always false,
  // which silently suppressed every payment confirmation send.
  const { data: transitioned, error: colErr } = await admin
    .from('vendor_applications')
    .update({
      paid_at: paidAtIso,
    })
    .eq('id', input.applicationId)
    .is('paid_at', null)
    .select('id')
  if (colErr) {
    console.error('[confirmPayment] paid_at transition failed:', colErr.message)
  }

  // This call won the unpaid -> paid transition iff the guarded UPDATE affected
  // exactly the unpaid row (returned >= 1 row). On a DB error we conservatively
  // treat the transition as NOT won (wonTransition = false) so a failed/ambiguous
  // write never triggers a send. A retried/concurrent duplicate matches 0 rows
  // here and therefore skips all sends below while the first caller proceeds.
  const wonFirst = !colErr && Array.isArray(transitioned) && transitioned.length > 0

  // Classify this call: first payment, genuine top-up, or duplicate/no-op.
  //  - wonFirst: this call atomically settled the FIRST payment.
  //  - top-up: vendor was ALREADY paid in a prior settled call, this is a NEW
  //    provider ref, and amount > 0 (operator added charges after payment; the
  //    vendor pays the difference). Gated on wasPaidBefore so two concurrent
  //    FIRST-payment webhooks can never both count (the loser of the atomic
  //    guard sees wasPaidBefore === false and no-ops).
  //  - otherwise: duplicate webhook / lost the first-payment race / colErr -> no-op.
  let isTopUp = false
  let newCumulative = amountPaidBefore
  if (wonFirst) {
    newCumulative = amount
  } else if (!colErr && wasPaidBefore && !isDuplicateRef && amount > 0) {
    isTopUp = true
    newCumulative = amountPaidBefore + amount
  } else {
    return { ok: true, alreadyPaid: true, amount: amountPaidBefore }
  }

  // Record cumulative paid + this ref in the marker (admin UI + portal read it).
  // Build the next state in memory so we can also stamp the owner-view cutoff
  // when an EFT-lane vendor is reconciled back through a normal channel. The
  // cutoff hides every EFT-era message from the festival owner.
  const prevRefs: string[] = Array.isArray((before.payment as { refs?: unknown } | undefined)?.refs)
    ? ((before.payment as { refs?: string[] }).refs as string[])
    : []
  const nextState: PortalState = {
    ...before,
    payment: {
      ...(before.payment || {}),
      status: 'paid',
      amount: newCumulative,
      method: input.method,
      provider_ref: ref || before.payment?.provider_ref,
      refs: ref ? Array.from(new Set([...prevRefs, ref])) : prevRefs,
      paid_at: before.payment?.paid_at || paidAtIso,
    },
    stage: before.stage === 'show_ready' ? 'show_ready' : 'paid',
  }
  let nextAdminNotes = updatePortalStateImpl(app.admin_notes as string, nextState)

  // If this is the FIRST paid transition and the vendor was on the master lane,
  // hide the entire EFT-era conversation from the festival owner. The cutoff is
  // set to the earliest EFT touch (revealed details / proof upload / collected),
  // falling back to the settlement time if no earlier timestamp exists.
  const wasMasterLane =
    before.payment?.status === 'collected'
    || ['eft', 'manual_card'].includes(String(before.payment?.method || ''))
    || hasEftMarker(app.admin_notes as string)
  if (wonFirst && paymentAlertAudience(input.method) === 'all' && wasMasterLane) {
    const cutAt = earliestEftTimestamp(before) || paidAtIso
    nextAdminNotes = withOwnerCutoff(nextAdminNotes, cutAt)
  }

  await admin
    .from('vendor_applications')
    .update({ admin_notes: nextAdminNotes })
    .eq('id', input.applicationId)

  // Signed proof-of-action for the money event. Reached only when THIS call won
  // the unpaid->paid transition or is a genuine top-up (the duplicate/no-op path
  // returned above), so each settlement is receipted exactly once under the
  // payments DID. Best-effort: recordLedger never throws into the money path.
  await recordLedger('payments', 'cth.pay.confirmed', {
    application_id: input.applicationId,
    business: app.business_name,
    amount,
    cumulative: newCumulative,
    method: input.method,
    provider_ref: ref || null,
    top_up: isTopUp,
    first_settlement: wonFirst,
  })

  // Send-gating: `silent` suppresses sends for backfill/corrections. Both a
  // first payment and a top-up send a confirmation for THIS payment's amount.
  if (input.silent) {
    return { ok: true, alreadyPaid: !wonFirst, amount }
  }

  const contactName = (app.contact_name as string) || 'there'
  const firstName = contactName.trim().split(/\s+/)[0] || contactName
  const businessName = (app.business_name as string) || 'your business'
  const providerRef = input.providerRef || ''

  const paidIso = new Date().toISOString()
  const paidDate = new Date(paidIso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'long', year: 'numeric',
  })
  // Vendor email: gated on notifyVendor (settlement path skips it — the vendor was
  // already acknowledged at the 'collected' stage).
  if (input.notifyVendor !== false) {
    await sendVendorPaymentEmail({
      to: app.email as string,
      contactName,
      businessName,
      amount,
      providerRef: providerRef || input.method,
      reference: before.payment?.reference || input.applicationId.slice(0, 8).toUpperCase(),
      paidDate,
      pricing,
    })
  }

  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({
      event: 'payment_succeeded',
      body: `${businessName} ${isTopUp ? 'paid an ADDITIONAL' : 'marked paid via ' + input.method + '. Amount'} ${formatRand(amount)}${isTopUp ? ` (total paid ${formatRand(newCumulative)})` : ''}${providerRef ? `, ref ${providerRef}` : ''}.`,
      audience: paymentAlertAudience(input.method),
    })
  } catch (e) {
    console.error('[confirmPayment] notify owners failed:', (e as Error).message)
  }

  // WhatsApp paid-confirmation via the shared helper (wa-meta registry guard +
  // observable failures). Gated on notifyVendor so the settlement path skips it.
  if (input.notifyVendor !== false) {
    await sendVendorPaymentWa({
      admin,
      waPhone: (before.wa?.phone as string) || (app.phone as string) || '',
      firstName,
      amount,
      stallLabel: pricing.stallLabel,
    })
  }

  // Logo nudge: the moment a vendor FIRST becomes paid, ask them to upload a
  // logo so they go live (with branding) in the public sector listings. Only on
  // the first paid transition, and only if no logo is on file yet. Best-effort,
  // NEVER throws into the money path. Weekly re-nudges are handled by the
  // /api/cron/logo-reminders sweep until the logo lands.
  // GATED ON notifyVendor TOO. It was not, and on 2026-07-28 a settlement run
  // with notifyVendor:false still emailed the vendor "One step left: add your
  // logo to go live". The flag is documented as "skip the VENDOR email +
  // WhatsApp"; a caller reading that has every reason to believe nothing reaches
  // the vendor, and every OTHER vendor-facing send here honours it. A flag that
  // covers two of three outbound paths is worse than no flag, because it is
  // trusted.
  if (input.notifyVendor !== false && !wasPaidBefore && !before.profile?.logo_path) {
    try {
      const { sendLogoReminder } = await import('@/lib/logo-reminder')
      await sendLogoReminder({
        applicationId: input.applicationId,
        name: contactName,
        email: app.email as string,
        phone: (before.wa?.phone as string) || (app.phone as string) || null,
      })
    } catch (e) {
      console.error('[confirmPayment] logo reminder failed:', (e as Error).message)
    }
  }

  // Reached only by the call that won the unpaid -> paid transition and sent.
  return { ok: true, alreadyPaid: false, amount }
}
