'use client'

// Owner "Mark as paid" for one EFT-proofs row. Posts to the fence-gated confirm
// route and refreshes the server component so the row flips to "Paid".

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Check } from 'lucide-react'

export function EftProofConfirmButton({ applicationId, name, amount, defaultAmount }: {
  applicationId: string
  name: string
  amount: string   // preformatted, e.g. "R9 000"
  /** Expected amount (this instalment / balance). Prefilled; the operator types
   *  what actually landed so a short payment stays PARTIAL (Abdusamee 2026-10-07:
   *  El chapo paid R2 200 of a R4 200 instalment). */
  defaultAmount: number
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function markPaid() {
    const raw = prompt(`Amount received from ${name} (expected ${amount}). Enter what is actually in the account. Less than expected keeps them on Partially paid. The vendor will get a payment confirmation for this amount.`, String(defaultAmount))
    if (raw === null) return
    const received = Math.round(Number(raw.replace(/[^\d.]/g, '')))
    if (!(received > 0)) { setErr('Enter the amount received'); return }
    if (received > defaultAmount && !confirm(`R${received} is more than the expected ${amount}. Record it anyway?`)) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/admin/eft-proofs/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId, amount: received }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Could not mark paid')
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not mark paid')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={markPaid}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[#cd2653] hover:bg-[#b01f45] text-white px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Mark as paid
      </button>
      {err && <span className="text-[11px] text-red-600">{err}</span>}
    </div>
  )
}
