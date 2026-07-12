// Single source of truth for marking a vendor payment as paid. Used by both
// the Yoco webhook (when the gateway confirms) and the admin "mark as paid"
// action (when an organiser reconciles an EFT/cash payment manually).
//
// Idempotent: re-running with the same applicationId is a no-op for emails
// and template messages (it never sends twice).

import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'
import { sendEmail } from '@/lib/email/resend'
import { VendorPaymentConfirmation } from '@/lib/email/templates/VendorPaymentConfirmation'
import { computeVendorPricing, formatRand } from '@/lib/payments/pricing'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { findWaTemplate, buildWaTemplateParams } from '@/lib/templates/wa-meta'

const SITE = 'https://cthalaal.co.za'

export type PaymentMethod = 'yoco' | 'eft' | 'cash' | 'manual_card' | 'waived'

export interface ConfirmPaymentInput {
  applicationId: string
  method: PaymentMethod
  amount?: number          // optional override; falls back to pricing.total
  providerRef?: string     // gateway txn id, EFT slip reference, "cash @ door", etc
  notes?: string           // admin-only note appended to admin_notes (not state)
  /** When true, skip outbound email + WhatsApp (useful for backfill / corrections). */
  silent?: boolean
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
  await updatePortalState(input.applicationId, (s) => {
    const prevRefs: string[] = Array.isArray((s.payment as { refs?: unknown } | undefined)?.refs)
      ? ((s.payment as { refs?: string[] }).refs as string[])
      : []
    return {
      ...s,
      payment: {
        ...(s.payment || {}),
        status: 'paid',
        amount: newCumulative,
        method: input.method,
        provider_ref: ref || s.payment?.provider_ref,
        refs: ref ? Array.from(new Set([...prevRefs, ref])) : prevRefs,
        paid_at: s.payment?.paid_at || paidAtIso,
      },
      stage: s.stage === 'show_ready' ? 'show_ready' : 'paid',
    }
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

  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({
      event: 'payment_succeeded',
      body: `${businessName} ${isTopUp ? 'paid an ADDITIONAL' : 'marked paid via ' + input.method + '. Amount'} ${formatRand(amount)}${isTopUp ? ` (total paid ${formatRand(newCumulative)})` : ''}${providerRef ? `, ref ${providerRef}` : ''}.`,
      audience: 'all',
    })
  } catch (e) {
    console.error('[confirmPayment] notify owners failed:', (e as Error).message)
  }

  // WhatsApp paid-confirmation is best-effort and secondary to the email above.
  // It NEVER throws into confirmPayment(). We route through the wa-meta registry
  // guard (mirrors notifyVendor): validate the template name + params BEFORE
  // hitting Meta, and make every outcome OBSERVABLE. This template ('vendor_
  // payment_confirmation') was historically NOT registered, so findWaTemplate
  // returned undefined and the send silently skipped. Now a missing/invalid
  // template is logged and written to wa_messages as a failed row instead of
  // vanishing. Param order MUST stay aligned with the wa-meta spec:
  // [first_name, amount(formatted Rand), stall_label].
  const TEMPLATE_KEY = 'vendor_payment_confirmation'
  const waPhone = (before.wa?.phone as string) || (app.phone as string) || ''
  if (waPhone) {
    const waTo = toE164(waPhone)
    const previewBody = `[${TEMPLATE_KEY}] Payment received, ${firstName}. Amount: ${formatRand(amount)}, Stall: ${pricing.stallLabel}`
    try {
      const spec = findWaTemplate(TEMPLATE_KEY)
      if (!spec) {
        // Registry guard: template name not registered in wa-meta. This is the
        // exact silent-skip the original bug caused. Surface it loudly + durably.
        const err = `wa template not registered: ${TEMPLATE_KEY}`
        console.error(`[confirmPayment] whatsapp skipped: ${err}`)
        await admin.from('wa_messages').insert({
          direction: 'out',
          wa_phone: waTo,
          body: previewBody,
          status: 'failed',
          provider_message_id: null,
          error: err,
        })
      } else {
        // Validate params against the spec (ordered + required checks) the same
        // way the inbox composer does, so a malformed payload fails observably
        // rather than rendering a broken template at Meta.
        const built = buildWaTemplateParams(spec, {
          first_name: firstName,
          amount: formatRand(amount),
          stall_label: pricing.stallLabel,
        })
        if (!built.ok) {
          const err = `wa template params invalid (${TEMPLATE_KEY}): ${built.error}`
          console.error(`[confirmPayment] whatsapp skipped: ${err}`)
          await admin.from('wa_messages').insert({
            direction: 'out',
            wa_phone: waTo,
            body: previewBody,
            status: 'failed',
            provider_message_id: null,
            error: err,
          })
        } else {
          const res = await sendTemplate(
            waTo,
            TEMPLATE_KEY,
            built.ordered,
            { category: spec.category }
          )
          if (res.skipped) {
            console.error(`[confirmPayment] whatsapp not sent (${TEMPLATE_KEY}): ${res.skipped}`)
          }
          await admin.from('wa_messages').insert({
            direction: 'out',
            wa_phone: waTo,
            body: previewBody,
            status: res.skipped ? 'failed' : 'sent',
            provider_message_id: res.messageId || null,
            error: res.skipped || null,
          })
        }
      }
    } catch (e) {
      console.error('[confirmPayment] whatsapp failed:', (e as Error).message)
    }
  }

  // Logo nudge: the moment a vendor FIRST becomes paid, ask them to upload a
  // logo so they go live (with branding) in the public sector listings. Only on
  // the first paid transition, and only if no logo is on file yet. Best-effort,
  // NEVER throws into the money path. Weekly re-nudges are handled by the
  // /api/cron/logo-reminders sweep until the logo lands.
  if (!wasPaidBefore && !before.profile?.logo_path) {
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
