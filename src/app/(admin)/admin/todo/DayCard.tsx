'use client'
import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Loader2 } from 'lucide-react'
import type { DayDigest, DayGroup } from '@/lib/day-digest'

const time = (iso: string) => { try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

// The four headline quadrants, always shown (0 included) so the grid is a stable
// 2x2 she can scan. Documents and reversals are appended only when they happened.
const PRIMARY: Array<{ key: DayGroup['key']; label: string; tone: string }> = [
  { key: 'received', label: 'Stall fees paid', tone: 'text-emerald-700' },
  { key: 'eft_pending', label: 'EFT payments in', tone: 'text-emerald-700' },
  { key: 'withdrawn', label: 'Withdrawals', tone: 'text-[#cd2653]' },
  { key: 'contract', label: 'Contracts signed', tone: 'text-neutral-800' },
]
const SECONDARY: Array<{ key: DayGroup['key']; label: string; tone: string }> = [
  { key: 'accessories', label: 'Accessories paid', tone: 'text-teal-700' },
  { key: 'plan', label: 'Plans & extensions', tone: 'text-blue-700' },
  { key: 'docs', label: 'Documents uploaded', tone: 'text-neutral-800' },
  { key: 'reversed', label: 'Payments reversed', tone: 'text-amber-700' },
]

function Tile({ label, tone, group }: { label: string; tone: string; group: DayGroup | undefined }) {
  const items = group?.items ?? []
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 min-h-[7rem]">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</h3>
        <span className={`text-2xl font-bold tabular-nums ${items.length ? tone : 'text-neutral-300'}`}>{items.length}</span>
      </div>
      {items.length > 0 && (
        <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
          {items.map((it, i) => (
            <li key={i} className="flex items-baseline justify-between gap-2 text-sm">
              <span className="text-neutral-800 truncate">{it.name}</span>
              <span className="text-neutral-400 shrink-0 text-xs">{it.detail}{it.at ? ` · ${time(it.at)}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function DayCard({ initial }: { initial: DayDigest }) {
  const [date, setDate] = useState(initial.date)
  const [digest, setDigest] = useState<DayDigest>(initial)
  const [loading, setLoading] = useState(false)
  const load = useCallback(async (d: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/day-digest?date=${encodeURIComponent(d)}`)
      if (res.ok) setDigest(await res.json())
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { if (date !== initial.date) load(date) }, [date, initial.date, load])

  const byKey = (k: DayGroup['key']) => digest.groups.find((g) => g.key === k)
  const secondaryShown = SECONDARY.filter((s) => (byKey(s.key)?.items.length ?? 0) > 0)

  return (
    <section>
      <header className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <CalendarDays className="w-4 h-4 text-neutral-500 shrink-0" />
          <h2 className="text-sm font-semibold text-neutral-800 truncate">What happened · {digest.dateLabel}</h2>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-neutral-400" />}
        </div>
        <input type="date" value={date} max={initial.date} onChange={(e) => setDate(e.target.value)}
          className="text-sm rounded-lg border border-neutral-200 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[#cd2653]/30" />
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {PRIMARY.map((q) => <Tile key={q.key} label={q.label} tone={q.tone} group={byKey(q.key)} />)}
        {secondaryShown.map((q) => <Tile key={q.key} label={q.label} tone={q.tone} group={byKey(q.key)} />)}
      </div>
      {digest.total === 0 && <p className="text-sm text-neutral-500 mt-2">Nothing recorded on this day.</p>}
    </section>
  )
}
