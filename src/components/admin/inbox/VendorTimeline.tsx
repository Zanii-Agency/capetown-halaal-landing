'use client'

/**
 * One vendor, every channel, in time order.
 *
 * This is the other half of the channel split. Taona, 2026-07-27: "Lets separate
 * the channels but how do we find a way that allows us to see messages from both
 * channels when we need to." The answer is that the channels meet on the VENDOR,
 * not in a list. A blended inbox of unrelated people is noise; one person's whole
 * history is context, and it is the only moment you actually want both at once.
 *
 * Backed by /api/admin/comms/timeline, which already existed, was already
 * lane-sealed, and had ZERO callers until now. It takes a contactId and resolves
 * the phone and email server-side, deliberately refusing an arbitrary ?phone= so
 * an admin session cannot be used to scrape anyone's WhatsApp history.
 *
 * Replaces the old Communication Log, which read from a separate server-side
 * payload, showed one flat list with no day boundaries, and could not page.
 */

import { useCallback, useEffect, useState } from 'react'
import { MessageCircle, Mail, StickyNote, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { fmtDay, fmtTime } from '@/lib/inbox/format'

interface TimelineRow {
  id: string
  channel: 'whatsapp' | 'email' | 'note'
  direction: 'in' | 'out' | 'note'
  body: string
  at: string
  source: string
  source_label: string
}

const PAGE = 40

const CHANNEL_STYLE: Record<TimelineRow['channel'], { Icon: typeof Mail; cls: string; label: string }> = {
  whatsapp: { Icon: MessageCircle, cls: 'bg-emerald-100 text-emerald-700', label: 'WhatsApp' },
  email: { Icon: Mail, cls: 'bg-sky-100 text-sky-700', label: 'Email' },
  note: { Icon: StickyNote, cls: 'bg-amber-100 text-amber-700', label: 'Note' },
}

export function VendorTimeline({ applicationId }: { applicationId: string }) {
  const [rows, setRows] = useState<TimelineRow[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async (offset: number) => {
    try {
      const r = await fetch(
        `/api/admin/comms/timeline?contactId=${encodeURIComponent(applicationId)}&limit=${PAGE}&offset=${offset}`,
        { cache: 'no-store' },
      )
      // A 403 here means the lane withheld this vendor. It must render as an
      // ORDINARY EMPTY HISTORY, never as a refusal. "This vendor is outside your
      // lane" told the festival owner that a lane exists, who is on it, and that
      // there is something she is not being shown — Taona 2026-07-28: "she
      // doesnt need to know about any lane". A wall that announces itself is not
      // a wall, it is a signpost to what it hides. Standard access-control
      // practice: an unauthorised read is indistinguishable from an empty one.
      if (r.status === 403) {
        setRows([]); setTotal(0); setHasMore(false); setError(null)
        return
      }
      if (!r.ok) throw new Error(`Could not load the history (${r.status})`)
      const j = await r.json()
      setRows((prev) => (offset === 0 ? j.rows || [] : [...prev, ...(j.rows || [])]))
      setTotal(j.pagination?.total ?? 0)
      setHasMore(!!j.pagination?.has_more)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [applicationId])

  useEffect(() => { setLoading(true); load(0) }, [load])

  function toggle(id: string) {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  if (loading) {
    return <p className="text-sm text-neutral-500 flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading history…</p>
  }
  if (error) return <p className="text-sm text-rose-600">{error}</p>
  if (!rows.length) return <p className="text-sm text-neutral-500">No messages recorded.</p>

  // Newest first from the API. Group by day so a long history is scannable.
  const days: Array<{ day: string; items: TimelineRow[] }> = []
  for (const r of rows) {
    const day = fmtDay(r.at)
    const last = days[days.length - 1]
    if (last && last.day === day) last.items.push(r)
    else days.push({ day, items: [r] })
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">
        {total} message{total === 1 ? '' : 's'} across WhatsApp, email and notes.
      </p>

      {days.map((d) => (
        <div key={d.day}>
          <div className="sticky top-0 z-10 -mx-1 px-1 py-1 bg-white/90 backdrop-blur text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            {d.day}
          </div>
          <div className="space-y-1 mt-1">
            {d.items.map((r) => {
              const { Icon, cls, label } = CHANNEL_STYLE[r.channel] ?? CHANNEL_STYLE.note
              const isLong = r.body.length > 160
              const open = expanded.has(r.id)
              return (
                <div key={r.id} className="rounded-lg border border-neutral-200 overflow-hidden">
                  <button
                    onClick={() => isLong && toggle(r.id)}
                    className={`w-full flex items-start gap-3 px-3 py-2.5 text-left ${isLong ? 'hover:bg-neutral-50' : 'cursor-default'}`}
                  >
                    <span className={`shrink-0 mt-0.5 w-6 h-6 rounded-full grid place-items-center ${cls}`} title={label}>
                      <Icon className="w-3 h-3" />
                    </span>
                    <span className="shrink-0 text-[11px] text-neutral-400 tabular-nums w-11 mt-1">
                      {fmtTime(r.at)}
                    </span>
                    <span className="shrink-0 text-[11px] font-medium text-neutral-600 w-16 truncate mt-1">
                      {/* Direction beats sender name: on a vendor page you always
                          know who the other party is, you want to know who spoke. */}
                      {r.direction === 'out' ? 'Us' : r.direction === 'note' ? 'Note' : 'Them'}
                    </span>
                    <span className={`flex-1 text-xs text-neutral-700 ${open ? 'whitespace-pre-wrap' : 'truncate'}`}>
                      {open || !isLong ? r.body : r.body.slice(0, 160) + '…'}
                    </span>
                    {isLong && (
                      <span className="shrink-0 text-neutral-400 mt-1">
                        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {hasMore && (
        <button
          onClick={() => load(rows.length)}
          className="w-full py-2 text-xs font-medium text-neutral-600 rounded-lg border border-neutral-200 hover:bg-neutral-50"
        >
          Load older ({total - rows.length} more)
        </button>
      )}
    </div>
  )
}
