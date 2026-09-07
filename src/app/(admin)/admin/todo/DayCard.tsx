'use client'
import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Loader2 } from 'lucide-react'
import type { DayDigest } from '@/lib/day-digest'

const time = (iso: string) => { try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

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
  return (
    <section className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-neutral-100">
        <div className="flex items-center gap-2 min-w-0">
          <CalendarDays className="w-4 h-4 text-neutral-500 shrink-0" />
          <h2 className="text-sm font-semibold text-neutral-800 truncate">What happened · {digest.dateLabel}</h2>
        </div>
        <input type="date" value={date} max={initial.date} onChange={(e) => setDate(e.target.value)}
          className="text-sm rounded-lg border border-neutral-200 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[#cd2653]/30" />
      </header>
      <div className="px-5 py-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-neutral-400 py-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : digest.total === 0 ? (
          <div className="text-sm text-neutral-500 py-2">Nothing recorded on this day.</div>
        ) : (
          <div className="space-y-4">
            {digest.groups.map((g) => (
              <div key={g.key}>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{g.label}</h3>
                  <span className="text-xs text-neutral-400">{g.items.length}</span>
                </div>
                <ul className="divide-y divide-neutral-50">
                  {g.items.map((it, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="text-sm text-neutral-800 truncate">{it.name}</span>
                      <span className="text-sm text-neutral-500 shrink-0">{it.detail}</span>
                      <span className="text-xs text-neutral-400 shrink-0 tabular-nums">{time(it.at)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
