'use client'

// Owner "Mark as paid" for one EFT-proofs row. Posts to the fence-gated confirm
// route and refreshes the server component so the row flips to "Paid".

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Check } from 'lucide-react'

export function EftProofConfirmButton({ applicationId, name, amount }: {
  applicationId: string
  name: string
  amount: string   // preformatted, e.g. "R9 000"
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function markPaid() {
    if (!confirm(`Mark ${name} as PAID for ${amount}? Do this only after you have checked the proof and the money is in the account. The vendor will get a payment confirmation.`)) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/admin/eft-proofs/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId }),
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
