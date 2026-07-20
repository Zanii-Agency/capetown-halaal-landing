'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { CreditCard, CheckCircle2, Clock, Loader2, Info, RefreshCw, MessageSquare } from 'lucide-react'

export default function PaymentPanel({
  enabled, status, amount, outstanding, reference, dueDate, attemptedAt, failedAttempts,
}: {
  enabled: boolean
  status: string
  amount: number | null
  outstanding?: number | null
  reference: string | null
  dueDate: string
  attemptedAt?: string | null
  failedAttempts?: number
}) {
  const params = useSearchParams()
  const justPaid = params.get('paid') === '1'
  const cancelled = params.get('cancelled') === '1'
  const failed = params.get('status') === 'failed'

  const [paying, setPaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  const isPaidStatus = status === 'paid' || justPaid
  // A top-up: the vendor already paid, but the operator added charges after
  // payment, so a balance is outstanding. `outstanding` is what is due NOW (the
  // difference). `fullyPaid` is paid with nothing left to settle.
  const payAmount = typeof outstanding === 'number' ? outstanding : amount
  const topUpDue = isPaidStatus && (payAmount || 0) > 0
  const fullyPaid = isPaidStatus && !topUpDue
  // "Pending" only counts if the attempt is FRESH. Yoco checkouts time out
  // after about 15 minutes — anything older is a stale row from an abandoned
  // attempt, treat it as "ready to retry" so we don't lie about progress.
  const PENDING_TTL_MIN = 15
  const attemptAgeMs = attemptedAt ? Date.now() - new Date(attemptedAt).getTime() : Infinity
  const isFreshPending = !isPaidStatus && status === 'pending' && attemptAgeMs < PENDING_TTL_MIN * 60_000
  const isStalePending = !isPaidStatus && status === 'pending' && attemptAgeMs >= PENDING_TTL_MIN * 60_000
  const tooManyFails = (failedAttempts || 0) >= 3
  const showPayBlock = !fullyPaid && (topUpDue || !isFreshPending || retrying || cancelled || failed || isStalePending)

  async function payByCard() {
    setPaying(true); setError(null)
    try {
      const res = await fetch('/api/exhibitor/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Could not start payment')
      window.location.href = j.url
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); setPaying(false) }
  }

  return (
    <div className="space-y-6">
      {justPaid && <div className="p-4 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">Thanks, your payment is being confirmed. This page will update once it clears.</div>}
      {cancelled && <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">Payment was cancelled. You can try again below.</div>}
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      {/* fee status */}
      <div className={`rounded-2xl p-6 border ${fullyPaid ? 'bg-green-50 border-green-200' : 'bg-[#1a1416] border-[#1a1416] text-white'}`}>
        <div className="flex items-center gap-3">
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${fullyPaid ? 'bg-green-100 text-green-600' : 'bg-white/10 text-[#ff7a9c]'}`}>
            {fullyPaid ? <CheckCircle2 className="w-5 h-5" /> : <CreditCard className="w-5 h-5" />}
          </div>
          <div>
            <p className={`text-sm ${fullyPaid ? 'text-green-700' : 'text-white/60'}`}>{topUpDue ? 'Additional payment due' : 'Stall fee'}</p>
            <p className={`text-2xl font-bold ${fullyPaid ? 'text-green-900' : 'text-white'}`}>
              {fullyPaid ? 'Paid' : payAmount ? `R${payAmount.toFixed(2)} due` : 'Amount pending'}
            </p>
            {!fullyPaid && <p className="text-sm text-white/60 mt-0.5 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> {topUpDue ? 'Extra charges were added to your stall' : `Payable by ${dueDate}`}{reference ? ` · ref ${reference}` : ''}</p>}
          </div>
        </div>
      </div>

      {/* Fresh pending (<15 min old): the user is mid-flow, bank may still be
          confirming. Hide Pay-now so we don't double-charge. */}
      {isFreshPending && !retrying && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 flex items-start gap-3">
          <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold text-blue-900 mb-1">Payment in progress</p>
            <p className="text-sm text-blue-800 mb-3">
              We&apos;re waiting for the bank to confirm your last payment.
              This usually takes under a minute. Refresh this page in a moment.
            </p>
            <button
              onClick={() => setRetrying(true)}
              className="text-xs font-semibold text-blue-900 underline hover:no-underline inline-flex items-center gap-1.5"
            >
              <RefreshCw className="w-3 h-3" /> Didn&apos;t go through? Try again
            </button>
          </div>
        </div>
      )}

      {/* Stale pending: previous attempt expired without confirming. Tell the
          truth: it didn't go through, restart. */}
      {isStalePending && !retrying && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-start gap-3">
          <RefreshCw className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold text-amber-900 mb-1">Last payment didn&apos;t go through</p>
            <p className="text-sm text-amber-800 mb-3">
              Your last card attempt expired without confirming. No money was taken. Start a new payment below.
            </p>
            <button
              onClick={() => setRetrying(true)}
              className="text-xs font-semibold text-amber-900 underline hover:no-underline inline-flex items-center gap-1.5"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {/* Explicit failure return from Yoco */}
      {failed && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-5 text-sm text-red-800">
          <p className="font-semibold mb-1">Payment failed</p>
          <p>Your card was declined or the payment was cancelled. No money was taken. Try again, or message us on WhatsApp if it keeps failing.</p>
        </div>
      )}

      {/* Repeated failures: route them to WhatsApp support directly */}
      {tooManyFails && !isPaidStatus && (
        <div className="bg-[#cd2653]/8 border border-[#cd2653]/40 rounded-2xl p-5 flex items-start gap-3">
          <MessageSquare className="w-5 h-5 text-[#cd2653] shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold text-[#cd2653] mb-1">{failedAttempts} attempts have failed</p>
            <p className="text-sm text-neutral-700 mb-3">
              Card payments aren&apos;t going through. Please WhatsApp the organisers and we&apos;ll arrange EFT or another way to pay.
            </p>
            <a
              href="https://wa.me/27682275246?text=Hi%2C%20my%20card%20payments%20keep%20failing%20on%20the%20YAH%20portal.%20Can%20you%20help%3F"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 bg-[#25d366] hover:bg-[#1f8a4a] text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
            >
              <MessageSquare className="w-4 h-4" /> WhatsApp +27 68 227 5246
            </a>
          </div>
        </div>
      )}

      {showPayBlock && (
        <>
          {/* card payment */}
          <div className="bg-white border border-neutral-200 rounded-2xl p-6">
            <p className="font-semibold text-neutral-900 mb-1">Pay by card</p>
            {enabled ? (
              <>
                <p className="text-sm text-neutral-500 mb-4">Secure card payment in South African Rand (ZAR), processed on FNB&rsquo;s 3D-Secure page. We never see or store your card number.</p>
                <button onClick={payByCard} disabled={paying || !payAmount}
                  className="bg-[#cd2653] hover:bg-[#b01f45] text-white font-semibold rounded-lg px-5 py-3 text-sm flex items-center gap-2 disabled:opacity-60">
                  {paying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                  {payAmount ? `Pay R${payAmount.toFixed(2)} now` : 'Amount pending'}
                </button>
                <p className="text-xs text-neutral-400 mt-3">By paying you agree to our <a href="/terms" className="underline hover:text-neutral-600">Terms</a> and <a href="/refund-policy" className="underline hover:text-neutral-600">Refund &amp; Cancellation Policy</a>.</p>
              </>
            ) : (
              <p className="text-sm text-neutral-500 flex items-start gap-2"><Info className="w-4 h-4 text-[#cd2653] mt-0.5 shrink-0" /> Card payment is being set up with our bank and opens shortly. Your spot is held in the meantime.</p>
            )}
          </div>

          {/* Card trouble? Route to support, organisers reconcile manually. */}
          <div className="bg-neutral-50 border border-neutral-200 rounded-2xl p-5">
            <p className="text-sm text-neutral-700 mb-3 flex items-start gap-2">
              <Info className="w-4 h-4 text-[#cd2653] mt-0.5 shrink-0" />
              Card not going through, or paying another way? Message the organisers and we&apos;ll sort it out with you.
            </p>
            <Link
              href="/exhibitor/portal/support"
              className="inline-flex items-center gap-2 text-sm font-semibold rounded-lg px-4 py-2 bg-white border border-neutral-200 hover:border-[#cd2653] hover:text-[#cd2653]"
            >
              <MessageSquare className="w-4 h-4" /> Message support
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
