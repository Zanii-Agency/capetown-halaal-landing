import Link from 'next/link'
import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { createAdminClient } from '@/lib/supabase/admin'
import { paymentsEnabled, paymentReference } from '@/lib/payments'
import { computeVendorPricing, formatRand } from '@/lib/payments/pricing'
import { computePaymentDue, daysUntil, fmtDate, requireContractSigned } from '@/lib/exhibitor-paygate'
import PaymentPanel from '@/components/exhibitor/PaymentPanel'
import EftPanel from '@/components/exhibitor/EftPanel'
import { getEftBankDetails, eftReference, getEftMode, vendorInEftLane } from '@/lib/eft'
import { AlertCircle, CheckCircle2, Clock, Download } from 'lucide-react'
import {
  PageShell, PageHeader, Card
} from '@/components/chrome/PageChrome'
import MiniTaskStrip from '@/components/exhibitor/MiniTaskStrip'

export const dynamic = 'force-dynamic'

export default async function PaymentsPage() {
  // Sequence gate: a vendor must sign the contract before they can pay.
  await requireContractSigned()
  const ctx = await getExhibitorContext()
  const app = ctx?.application
  const state = parsePortalState(app?.admin_notes as string)
  const status = state.payment?.status || 'none'
  const dueDate = app ? computePaymentDue(app as { payment_due_date?: string | null; reviewed_at?: string | null }) : null
  const due = dueDate ? fmtDate(dueDate) : (app?.payment_due_date as string) || 'TBC'
  const daysLeft = dueDate ? daysUntil(dueDate) : null
  const reference = state.payment?.reference || (app ? paymentReference(app.id as string) : null)
  const attemptedAt = state.payment?.attempted_at as string | undefined
  const failedAttempts = (state.payment?.failed_attempts as number | undefined) || 0

  // TEMPORARY EFT lane: a vendor pays by EFT while Yoco is down when global EFT
  // mode is ON, or when an operator selected them individually (⟦EFT⟧). They see
  // EftPanel (bank details + proof upload) instead of the Yoco panel; once a proof
  // is on file the portal reads a provisional "received, pending" state.
  const eftModeOn = await getEftMode()
  // Paid vendors are excluded from the lane (they keep their normal paid view even
  // under global mode); only unpaid lane vendors see the EFT panel.
  const inEftLane = vendorInEftLane(app?.admin_notes as string, eftModeOn, app?.paid_at as string | null)
  const eftSubmitted = !!state.payment?.eft_submitted_at
  const eftPending = eftSubmitted && status !== 'paid'
  const eftRef = app ? eftReference(app as { id?: string | null; admin_notes?: string | null }) : 'CTH'

  // EFT payment receipts / refund proofs an organiser uploaded for this vendor.
  // Each proof's file lives in the private vendor-docs bucket; we mint a short
  // lived signed URL server-side (Law 2). This page is already scoped to the
  // logged-in vendor's own application, so only their own proofs are listed.
  // A proof whose signed URL cannot be minted is skipped, never crashes the page.
  const proofs = state.payment?.proofs || []
  const proofViews = proofs.length > 0
    ? (await Promise.all(
        proofs.map(async (p) => {
          if (!p.path || typeof p.path !== 'string' || p.path.trim().length === 0) return null
          try {
            const admin = createAdminClient()
            // Long-lived link (1 year). The proof is only reachable from this
            // authenticated vendor portal (the portal is the security boundary),
            // and this page re-mints the URL on every visit, so the link does
            // not practically expire on the vendor.
            const { data } = await admin.storage.from('vendor-docs').createSignedUrl(p.path, 60 * 60 * 24 * 365)
            if (!data?.signedUrl) return null
            return {
              kind: p.kind,
              note: p.note,
              uploaded_at: p.uploaded_at,
              url: data.signedUrl,
            }
          } catch {
            return null
          }
        })
      )).filter((p): p is NonNullable<typeof p> => p !== null)
    : []

  // Compute the itemised breakdown from the application data so the vendor sees
  // exactly what they're paying for. An organiser-set state.payment.amount
  // overrides only the total (e.g. for special-case quotes).
  const pricing = app
    ? computeVendorPricing({
        preferred_booth_tier: app.preferred_booth_tier as string,
        special_requirements: app.special_requirements,
      })
    : null
  // Balance model: state.payment.amount = cumulative amount PAID; owed = the live
  // computed total; outstanding = what is still due. A top-up is when the operator
  // added charges after the vendor paid, leaving an outstanding balance.
  const owed = pricing?.total ?? null
  const paidSoFar = Number(state.payment?.amount) || 0
  const outstanding = owed !== null ? Math.max(0, owed - paidSoFar) : null
  const fullyPaid = status === 'paid' && (outstanding === null || outstanding <= 0)
  const topUpDue = paidSoFar > 0 && (outstanding || 0) > 0
  const amount = owed

  // Countdown banner. Until the vendor pays, the rest of the portal is locked
  // (requirePaid on every other route redirects them here). The banner makes
  // the 30-day window obvious and the consequence concrete.
  // Suppress the card-centric countdown (it mentions WhatsApp reminders) for any
  // EFT-lane vendor and once EFT proof is in.
  const showCountdown = status !== 'paid' && !eftPending && !inEftLane && daysLeft !== null
  const countdownTone =
    daysLeft === null ? 'neutral'
    : daysLeft < 0 ? 'overdue'
    : daysLeft <= 7 ? 'urgent'
    : daysLeft <= 14 ? 'warn'
    : 'ok'
  const toneStyles: Record<string, string> = {
    ok:      'bg-emerald-50 border-emerald-200 text-emerald-800',
    warn:    'bg-amber-50  border-amber-200 text-amber-800',
    urgent:  'bg-orange-50 border-orange-200 text-orange-800',
    overdue: 'bg-[#cd2653]/10 border-[#cd2653]/40 text-[#bf3026]',
    neutral: 'bg-neutral-50 border-neutral-200 text-neutral-700',
  }

  return (
    <PageShell>
      <MiniTaskStrip activeKey="payment" />
      <PageHeader
        kicker="Payments"
        title={eftPending ? 'Payment received' : fullyPaid ? 'You are paid in full' : topUpDue ? 'Additional payment due' : 'Pay your stall fee'}
        subtitle={eftPending
          ? 'We have your EFT proof and your portal is unlocked. Our team will confirm your payment shortly.'
          : fullyPaid
          ? 'Thank you. Your booth is confirmed. The full festival portal is unlocked for you below.'
          : topUpDue
          ? 'Extra charges were added to your stall. Please settle the balance below to stay confirmed.'
          : inEftLane
          ? 'Card payments are paused. Please pay by EFT using the details below and upload your proof of payment.'
          : 'Your portal unlocks the moment your stall fee clears. Pay by card via Yoco, EFT details on request via support.'}
      />

      {/* Wrong size? Let the vendor change stall size before paying so the fee
          matches the booth they want. Reachable pre-payment (stall-request page
          gates on approval, not payment). */}
      {!fullyPaid && !eftPending && (
        <div className="rounded-2xl border border-[#cd2653]/20 bg-[#cd2653]/5 p-4 mb-6 text-sm text-[#1B1A17]">
          Need a bigger or smaller booth? Change your stall size or request a different position{' '}
          <Link href="/exhibitor/portal/stand/change" className="font-semibold text-[#cd2653] underline underline-offset-2">
            before you pay
          </Link>
          , so your fee matches the stall you want.
        </div>
      )}

      {/* Countdown banner */}
      {showCountdown && (
        <div className={`rounded-2xl border p-5 mb-6 flex items-start gap-4 ${toneStyles[countdownTone]}`}>
          {countdownTone === 'overdue' ? <AlertCircle className="w-6 h-6 shrink-0 mt-0.5" /> : <Clock className="w-6 h-6 shrink-0 mt-0.5" />}
          <div className="flex-1">
            <p className="font-bold text-base">
              {daysLeft! < 0
                ? `${Math.abs(daysLeft!)} day${Math.abs(daysLeft!) === 1 ? '' : 's'} overdue`
                : daysLeft === 0
                ? 'Due today'
                : `${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining`}
            </p>
            <p className="text-sm mt-1 opacity-90">
              Stall fee due by <strong>{due}</strong>. Until you pay, every other page in your portal is locked. We send reminders by email and WhatsApp once a week until payment clears.
            </p>
          </div>
        </div>
      )}

      {fullyPaid && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 mb-6 flex items-start gap-4 text-emerald-800">
          <CheckCircle2 className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Payment confirmed</p>
            <p className="text-sm mt-1 opacity-90">
              Your booth is locked in. Use the menu above to view your stand, upload documents, register staff and watch announcements.
            </p>
          </div>
        </div>
      )}

      {topUpDue && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 mb-6 flex items-start gap-4 text-amber-800">
          <AlertCircle className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Additional payment due: {formatRand(outstanding || 0)}</p>
            <p className="text-sm mt-1 opacity-90">
              You have paid {formatRand(paidSoFar)} so far. Extra charges were added to your stall, so a balance of {formatRand(outstanding || 0)} is now due. Settle it below to keep your booth confirmed.
            </p>
          </div>
        </div>
      )}

      <div className="space-y-6">
        {pricing && pricing.total > 0 && (
          <Card>
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold">Itemised breakdown</p>
              {status === 'paid' && (
                <Link
                  href="/exhibitor/portal/invoice"
                  className="text-xs font-semibold text-[#cd2653] hover:underline"
                >
                  View invoice
                </Link>
              )}
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-[#1B1A17]/70">{pricing.stallLabel}</span>
                <span className="text-[#1B1A17] font-medium">{formatRand(pricing.stallPrice)}</span>
              </div>
              {pricing.electricalItems.map((it, i) => (
                <div key={i} className="flex justify-between">
                  <span className="text-[#1B1A17]/70">
                    {it.label}
                    {it.qty && it.qty > 1 ? ` × ${it.qty}` : ''}
                  </span>
                  <span className="text-[#1B1A17] font-medium">{formatRand(it.amount)}</span>
                </div>
              ))}
              {pricing.chairsQty > 0 && (
                <div className="flex justify-between">
                  <span className="text-[#1B1A17]/70">Chairs hired × {pricing.chairsQty}</span>
                  <span className="text-[#1B1A17] font-medium">{formatRand(pricing.chairsAmount)}</span>
                </div>
              )}
              {pricing.tablesQty > 0 && (
                <div className="flex justify-between">
                  <span className="text-[#1B1A17]/70">Tables hired × {pricing.tablesQty}</span>
                  <span className="text-[#1B1A17] font-medium">{formatRand(pricing.tablesAmount)}</span>
                </div>
              )}
            </div>
            <div className="border-t border-[#B8924A]/15 mt-4 pt-3 flex justify-between items-baseline">
              <span className="font-semibold text-[#1B1A17]">Total</span>
              <span className="font-serif text-2xl text-[#cd2653] font-semibold">
                {amount !== null ? formatRand(amount) : 'TBC'}
              </span>
            </div>
            {paidSoFar > 0 && (
              <div className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-[#1B1A17]/70">Paid so far</span>
                  <span className="text-emerald-700 font-medium">{formatRand(paidSoFar)}</span>
                </div>
                {(outstanding || 0) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-[#1B1A17]/70">Outstanding</span>
                    <span className="text-[#cd2653] font-semibold">{formatRand(outstanding || 0)}</span>
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        {inEftLane && !fullyPaid ? (
          <EftPanel
            submitted={eftSubmitted}
            bank={getEftBankDetails()}
            reference={eftRef}
            amount={outstanding ?? amount}
            businessName={(app?.business_name as string) || 'your business'}
          />
        ) : (
          <PaymentPanel
            enabled={paymentsEnabled()}
            status={status}
            amount={amount}
            outstanding={outstanding}
            reference={reference}
            dueDate={due}
            attemptedAt={attemptedAt || null}
            failedAttempts={failedAttempts}
          />
        )}

        {proofViews.length > 0 && (
          <Card>
            <p className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold mb-4">
              Payment &amp; refund proofs
            </p>
            <ul className="space-y-3">
              {proofViews.map((p, i) => (
                <li
                  key={i}
                  className="flex items-start justify-between gap-4 rounded-xl border border-[#B8924A]/15 bg-white p-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#1B1A17]">
                      {p.kind === 'refund' ? 'Refund proof' : p.kind === 'eft_submission' ? 'Your EFT proof' : 'Payment receipt'}
                    </p>
                    {p.note && (
                      <p className="text-sm text-[#1B1A17]/70 mt-0.5 break-words">{p.note}</p>
                    )}
                    {p.uploaded_at && (
                      <p className="text-xs text-[#1B1A17]/50 mt-1">
                        Uploaded {fmtDate(p.uploaded_at)}
                      </p>
                    )}
                  </div>
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-[#cd2653]/30 px-3 py-1.5 text-xs font-semibold text-[#cd2653] hover:bg-[#cd2653]/5"
                  >
                    <Download className="w-3.5 h-3.5" /> View
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </PageShell>
  )
}
