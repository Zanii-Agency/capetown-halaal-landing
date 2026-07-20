'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CreditCard, FileText, Loader2, Check, RefreshCw } from 'lucide-react'
import { StatusPill } from '@/components/chrome/StatusPill'
import type { PortalState } from '@/lib/portal-state'
import { computeVendorPricing, formatRand } from '@/lib/payments/pricing'

// Maps a payment status to a StatusPill tone, mirroring statusTone in
// Vendor360.tsx so the pill colour stays consistent across the profile.
function paymentTone(status: string): 'success' | 'warn' | 'danger' | 'info' | 'neutral' {
  switch (status) {
    case 'paid': return 'success'
    case 'pending': case 'deferred': return 'warn'
    case 'waived': return 'info'
    default: return 'neutral'
  }
}

// Format an ISO date the same way Vendor360.tsx fmtDate does, so the proof
// timestamps read consistently with the rest of the profile.
function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

export function VendorPaymentsSection({
  applicationId,
  vendor,
  portal,
}: {
  applicationId: string
  vendor: Record<string, unknown>
  portal: PortalState
}) {
  // Owed comes from computeVendorPricing (single source of truth for the fee);
  // paid is the CUMULATIVE figure stored in portal.payment.amount; outstanding
  // is whatever the vendor still has to settle.
  const pricing = computeVendorPricing({
    preferred_booth_tier: vendor.preferred_booth_tier as string,
    special_requirements: vendor.special_requirements,
  })
  const owed = pricing.total
  const paid = portal.payment?.amount || 0
  const outstanding = Math.max(0, owed - paid)

  const status = portal.payment?.status || 'none'
  const method = portal.payment?.method
  const reference = portal.payment?.reference
  const proofs = portal.payment?.proofs || []

  // Resend invoice: best-effort, never crashes the section. The route expects
  // { applicationId } and returns { ok, to, amount } or { ok:false, error }.
  const [resendBusy, setResendBusy] = useState(false)
  const [resendOk, setResendOk] = useState<string | null>(null)
  const [resendErr, setResendErr] = useState<string | null>(null)

  async function handleResend() {
    setResendBusy(true)
    setResendOk(null)
    setResendErr(null)
    try {
      const r = await fetch('/api/admin/payments/resend-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) {
        setResendErr(j.error || `Failed (${r.status})`)
        return
      }
      setResendOk(j.to ? `Sent to ${j.to}` : 'Sent')
    } catch (e) {
      setResendErr((e as Error).message || 'Resend failed')
    } finally {
      setResendBusy(false)
    }
  }

  return (
    <section className="bg-[var(--bg-surface)] rounded-lg border border-[var(--border)] shadow-sm p-5">
      <h3 className="font-serif text-lg text-[var(--text-primary)] mb-4 flex items-center gap-2">
        <CreditCard className="w-4 h-4" /> Payments &amp; Invoice
      </h3>

      {/* Summary grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <SummaryField label="Total owed" value={formatRand(owed)} />
        <SummaryField label="Paid so far" value={formatRand(paid)} />
        <SummaryField
          label="Outstanding"
          value={formatRand(outstanding)}
          emphasis={outstanding > 0}
        />
        <div>
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">Status</p>
          <StatusPill tone={paymentTone(status)} label={status} />
        </div>
        <SummaryField label="Method" value={method || '—'} />
        <SummaryField label="Reference" value={reference || '—'} mono />
      </div>

      {/* Additional payment due highlight: only when they have already paid
          something but still owe more (a top-up scenario). */}
      {outstanding > 0 && paid > 0 && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
          <p className="text-xs font-semibold text-amber-800">
            Additional payment due: {formatRand(outstanding)}
          </p>
          <p className="text-xs text-amber-700 mt-0.5">
            Vendor has paid {formatRand(paid)} of {formatRand(owed)}.
          </p>
        </div>
      )}

      {/* Itemised breakdown: stall + each electrical/custom line item. */}
      <div className="mt-5">
        <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2">Itemised</p>
        <div className="rounded-md border border-neutral-200 divide-y divide-neutral-100">
          <LineRow label={pricing.stallLabel} amount={formatRand(pricing.stallPrice)} />
          {pricing.electricalItems.map((item, i) => (
            <LineRow
              key={`${item.label}-${i}`}
              label={item.qty && item.qty > 1 ? `${item.label} ×${item.qty}` : item.label}
              amount={formatRand(item.amount)}
            />
          ))}
          <LineRow label="Total" amount={formatRand(owed)} bold />
        </div>
      </div>

      {/* Buttons row */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          href={`/admin/applications/${applicationId}/invoice`}
          className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md border border-neutral-200 text-neutral-700 hover:bg-neutral-50"
        >
          <FileText className="w-4 h-4" /> View invoice
        </Link>
        <button
          onClick={handleResend}
          disabled={resendBusy}
          className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md bg-[#cd2653] text-white hover:bg-[#b01f45] disabled:opacity-60"
        >
          {resendBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Resend invoice
        </button>
        {resendOk && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
            <Check className="w-3.5 h-3.5" /> {resendOk}
          </span>
        )}
        {resendErr && <span className="text-xs text-red-600">{resendErr}</span>}
      </div>

      {/* EFT / refund proofs: metadata only. Files live in the private
          vendor-docs bucket; building a public URL would leak them (Law 2), and
          a signed-url route is out of scope, so we list metadata only. */}
      {proofs.length > 0 && (
        <div className="mt-6">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2">
            EFT &amp; refund proofs
          </p>
          <ul className="space-y-2">
            {proofs.map((p, i) => (
              <li
                key={`${p.path}-${i}`}
                className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-neutral-800">
                    {p.kind === 'refund' ? 'Refund proof' : 'Payment receipt'}
                  </span>
                  <span className="text-xs text-neutral-400 tabular-nums">
                    {fmtDate(p.uploaded_at)}
                  </span>
                </div>
                {p.note && <p className="text-xs text-neutral-600 mt-1">{p.note}</p>}
                <p className="text-[11px] text-neutral-400 mt-1">Uploaded by operator</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function SummaryField({
  label,
  value,
  mono,
  emphasis,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  emphasis?: boolean
}) {
  return (
    <div>
      <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">{label}</p>
      <p
        className={`text-sm ${mono ? 'font-mono text-xs' : ''} ${
          emphasis ? 'text-amber-700 font-semibold' : 'text-neutral-800'
        }`}
      >
        {value}
      </p>
    </div>
  )
}

function LineRow({ label, amount, bold }: { label: string; amount: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <span className={`text-sm ${bold ? 'font-semibold text-neutral-900' : 'text-neutral-700'}`}>
        {label}
      </span>
      <span className={`text-sm tabular-nums ${bold ? 'font-semibold text-neutral-900' : 'text-neutral-700'}`}>
        {amount}
      </span>
    </div>
  )
}
