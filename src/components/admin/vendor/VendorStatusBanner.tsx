'use client'

import { CheckCircle2, Clock, ArrowRight } from 'lucide-react'
import { StatusPill } from '@/components/chrome/StatusPill'
import type { PortalState } from '@/lib/portal-state'

// At-a-glance "where this vendor stands + what's next" banner for the admin
// vendor profile. Everything here is computed DETERMINISTICALLY from the
// vendor's real fields, mirroring vendorNextStep in src/lib/bot/identity.ts so
// the operator and the WhatsApp bot tell the vendor the EXACT same next step.
// No actions, no fetches: pure read-only summary.

interface ChipState {
  label: string
  done: boolean
}

// Resolve the four gating chips + the single next-step line. Resolution order
// matches identity.ts vendorNextStep: rejected short-circuits first, then we
// walk approval -> contract -> payment -> stall.
function deriveState(
  status: string,
  contractSigned: boolean,
  paymentStatus: string,
  stallCode: string | null,
): { chips: ChipState[]; next: string; allSet: boolean } {
  const s = (status || '').toLowerCase()
  const payment = (paymentStatus || '').toLowerCase()
  const isRejected = /reject|declin|unsuccess|not approv/.test(s)
  const isApproved = /approv|confirm|accept/.test(s)
  const isPaid = payment === 'paid' || payment === 'waived'

  const chips: ChipState[] = [
    { label: isApproved ? 'Approved' : isRejected ? 'Not approved' : 'In review', done: isApproved },
    { label: contractSigned ? 'Contract signed' : 'Contract not signed', done: contractSigned },
    { label: isPaid ? 'Paid' : 'Payment pending', done: isPaid },
    { label: stallCode ? `Stall ${stallCode}` : 'Stall not allocated', done: !!stallCode },
  ]

  let next: string
  let allSet = false
  if (isRejected) {
    next = 'Application was not successful. Point them to support@youngatheart.co.za.'
  } else if (!isApproved) {
    next = 'Application in review. Approved within a few working days, vendor gets a WhatsApp and email on approval.'
  } else if (!contractSigned) {
    next = 'Vendor to sign the contract in the portal.'
  } else if (!isPaid) {
    next = 'Awaiting payment of the stall fee.'
  } else if (!stallCode) {
    next = 'Allocate a stall.'
  } else {
    next = 'All set.'
    allSet = true
  }

  return { chips, next, allSet }
}

export function VendorStatusBanner({
  vendor,
  portal,
  stallCode,
}: {
  vendor: Record<string, unknown>
  portal: import('@/lib/portal-state').PortalState
  stallCode: string | null
}) {
  const status = String(vendor.status || 'pending')
  const contractSigned = !!vendor.contract_signed_at
  const paymentStatus = String((portal as PortalState).payment?.status || 'none')

  const { chips, next, allSet } = deriveState(status, contractSigned, paymentStatus, stallCode)

  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 mb-4">
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((chip, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <StatusPill tone={chip.done ? 'success' : 'warn'} label={chip.label} />
            {i < chips.length - 1 && (
              <span className="text-neutral-300 select-none" aria-hidden>
                ·
              </span>
            )}
          </span>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 text-sm">
        {allSet ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
        ) : (
          <ArrowRight className="w-4 h-4 text-neutral-400 shrink-0" />
        )}
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          {allSet ? 'Status' : 'Next'}
        </span>
        <span className="text-neutral-700">{next}</span>
        {!allSet && <Clock className="w-3.5 h-3.5 text-neutral-300 shrink-0" />}
      </div>
    </div>
  )
}
