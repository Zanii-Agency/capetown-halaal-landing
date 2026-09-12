'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Minus, Zap, Check } from 'lucide-react'

export interface ApplianceOption { key: string; label: string; price: number }

const rand = (n: number) => `R${n.toLocaleString('en-ZA')}`

export default function AddAppliances({ catalog }: { catalog: ApplianceOption[] }) {
  const router = useRouter()
  const [qty, setQty] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bump = (key: string, delta: number) =>
    setQty((q) => ({ ...q, [key]: Math.max(0, Math.min(10, (q[key] || 0) + delta)) }))

  const items = catalog
    .filter((c) => (qty[c.key] || 0) > 0)
    .map((c) => ({ key: c.key, qty: qty[c.key], label: c.label, price: c.price }))
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0)

  async function submit() {
    if (!items.length || busy) return
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/exhibitor/appliances/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map((i) => ({ key: i.key, qty: i.qty })) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data?.error || 'Could not add appliances. Please try again.'); return }
      setDone(true); setQty({})
      // Refresh so the balance and itemised breakdown above update immediately.
      router.refresh()
    } catch {
      setError('Could not add appliances. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-[#B8924A]/20 bg-white p-5">
      <div className="flex items-center gap-2 mb-1">
        <Zap className="w-4 h-4 text-[#cd2653]" />
        <p className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold">Add more appliances</p>
      </div>
      <p className="text-sm text-[#1B1A17]/70 mb-4">
        Need extra power on the day? Add appliances below. The cost is added to your accessories balance, then you can pay it here. Prices are per appliance for the festival.
      </p>

      <div className="divide-y divide-[#F0E9D6]">
        {catalog.map((c) => {
          const n = qty[c.key] || 0
          return (
            <div key={c.key} className="flex items-center gap-3 py-2.5">
              <div className="flex-1 min-w-0">
                <span className="text-sm text-[#1B1A17]">{c.label}</span>
                <span className="text-xs text-[#1B1A17]/50 ml-2">{rand(c.price)}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button" aria-label={`Remove one ${c.label}`} onClick={() => bump(c.key, -1)} disabled={n === 0 || busy}
                  className="w-7 h-7 rounded-full border border-[#E5DCC4] flex items-center justify-center text-[#1B1A17]/70 disabled:opacity-30 hover:border-[#cd2653]"
                ><Minus className="w-3.5 h-3.5" /></button>
                <span className="w-5 text-center text-sm font-semibold text-[#1B1A17]">{n}</span>
                <button
                  type="button" aria-label={`Add one ${c.label}`} onClick={() => bump(c.key, +1)} disabled={busy}
                  className="w-7 h-7 rounded-full border border-[#E5DCC4] flex items-center justify-center text-[#cd2653] disabled:opacity-30 hover:border-[#cd2653]"
                ><Plus className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          )
        })}
      </div>

      {done && !items.length && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <Check className="w-4 h-4" /> Added to your bill. Your balance below is updated, settle it whenever you are ready.
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-xl border border-[#cd2653]/30 bg-[#cd2653]/5 px-4 py-3 text-sm text-[#cd2653]">{error}</div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <span className="text-sm text-[#1B1A17]/70">Adding: <strong className="text-[#1B1A17]">{rand(subtotal)}</strong></span>
        <button
          type="button" onClick={submit} disabled={!items.length || busy}
          className="rounded-xl bg-[#cd2653] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 hover:bg-[#b51f45]"
        >{busy ? 'Adding…' : 'Add to my bill'}</button>
      </div>
    </div>
  )
}
