'use client'

/**
 * Who am I talking to, and what has the team already said about them.
 *
 * Two things the old inbox had and the channel rebuild shipped without: the
 * vendor context strip (status, stall, payment, tier) and internal notes. An
 * operator replying to "where do I stand?" had to open another tab to find out.
 *
 * Both endpoints already existed and had no caller from these pages:
 *   GET  /api/admin/inbox/unified/context?applicationId=
 *   GET/POST /api/admin/inbox/unified/notes
 *
 * Notes live in vendor_applications.admin_notes as a marker block (Law 8, no
 * DDL), which is the same field the stall, EFT and merge markers use.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2, StickyNote, X, Send } from 'lucide-react'

interface Ctx {
  status: string
  tier: string | null
  sector: string | null
  payment?: { status?: string | null; amount?: number | null }
  stall?: string | null
  contract_signed_at?: string | null
}

interface Note { at: string; by: string; text: string }

export function VendorPanel({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, n] = await Promise.all([
        fetch(`/api/admin/inbox/unified/context?applicationId=${applicationId}`, { cache: 'no-store' }),
        fetch(`/api/admin/inbox/unified/notes?applicationId=${applicationId}`, { cache: 'no-store' }),
      ])
      if (c.ok) { const j = await c.json(); setCtx(j.context ?? null) }
      if (n.ok) { const j = await n.json(); setNotes(j.notes || []) }
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [applicationId])

  useEffect(() => { load() }, [load])

  async function addNote() {
    const text = draft.trim()
    if (!text || saving) return
    setSaving(true)
    try {
      const r = await fetch('/api/admin/inbox/unified/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applicationId, text }),
      })
      if (!r.ok) throw new Error(`Could not save the note (${r.status})`)
      setDraft('')
      load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <aside className="w-[280px] shrink-0 flex flex-col min-h-0 rounded-xl border border-neutral-200 bg-white">
      <header className="px-3 py-2.5 border-b border-neutral-200 flex items-center gap-2">
        <StickyNote className="h-3.5 w-3.5 text-neutral-400" />
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Vendor</p>
        <button onClick={onClose} aria-label="Close panel"
          className="ml-auto text-neutral-400 hover:text-neutral-700">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {loading && <p className="text-xs text-neutral-500 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>}
        {err && <p className="text-xs text-rose-600">{err}</p>}

        {ctx && (
          <dl className="space-y-1.5 text-xs">
            <Row label="Status" value={ctx.status} />
            {ctx.payment?.status && <Row label="Payment" value={ctx.payment.status} />}
            {ctx.stall && <Row label="Stall" value={ctx.stall} />}
            {ctx.tier && <Row label="Tier" value={ctx.tier} />}
            {ctx.sector && <Row label="Sector" value={ctx.sector} />}
            <Row label="Contract" value={ctx.contract_signed_at ? 'Signed' : 'Not signed'} />
          </dl>
        )}

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 mb-1.5">Internal notes</p>
          {notes.length === 0 && !loading && <p className="text-xs text-neutral-400">No notes yet.</p>}
          <div className="space-y-2">
            {[...notes].reverse().map((n, i) => (
              <div key={i} className="rounded-lg bg-neutral-50 border border-neutral-200 px-2.5 py-2">
                <p className="text-xs text-neutral-700 whitespace-pre-wrap">{n.text}</p>
                <p className="mt-1 text-[10px] text-neutral-400">
                  {n.by} · {new Date(n.at).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' })}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <footer className="p-2 border-t border-neutral-200">
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote() } }}
            rows={2}
            placeholder="Note for the team, never sent to the vendor"
            className="flex-1 resize-none px-2 py-1.5 text-xs rounded-md border border-neutral-200 focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
          />
          <button
            onClick={addNote}
            disabled={!draft.trim() || saving}
            aria-label="Save note"
            className="h-7 w-7 grid place-items-center rounded-md bg-neutral-900 text-white disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          </button>
        </div>
      </footer>
    </aside>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-16 shrink-0 text-neutral-400">{label}</dt>
      <dd className="font-medium text-neutral-800 capitalize">{value}</dd>
    </div>
  )
}
