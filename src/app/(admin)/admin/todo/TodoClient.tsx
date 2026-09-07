'use client'

import { useCallback, useState } from 'react'
import { CheckCircle2, ChevronRight, ExternalLink, Loader2, Send, X } from 'lucide-react'
import type { Todo, TodoItem } from '@/lib/todo'

type Msg = { id: string; channel?: string; direction: 'in' | 'out'; body: string; at: string; from?: string }

function ago(iso: string | null): string {
  if (!iso) return ''
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 36e5)
  if (h < 1) return 'now'
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
const fmtWhen = (iso: string) => { try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) } catch { return '' } }
async function postJSON(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok && data?.ok !== false && !data?.error, data }
}

// Section -> accent colour + count-pill classes
const TONE: Record<string, { pill: string }> = {
  whatsapp_reply: { pill: 'bg-[#cd2653]/10 text-[#cd2653]' },
  email_reply: { pill: 'bg-blue-50 text-blue-700' },
  stall_change: { pill: 'bg-violet-50 text-violet-700' },
  portal_support: { pill: 'bg-amber-50 text-amber-700' },
  eft_proof: { pill: 'bg-emerald-50 text-emerald-700' },
  task: { pill: 'bg-neutral-100 text-neutral-700' },
}

function Thread({ item }: { item: TodoItem }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    if (msgs || loading) return
    setLoading(true)
    try {
      const qs = item.phone ? `phone=${encodeURIComponent(item.phone)}` : item.email ? `email=${encodeURIComponent(item.email)}` : ''
      if (!qs) { setMsgs([]); return }
      const res = await fetch(`/api/admin/inbox/unified/messages?${qs}`)
      const data = await res.json().catch(() => ({}))
      const list: Msg[] = Array.isArray(data?.messages) ? data.messages : []
      list.sort((a, b) => (a.at < b.at ? 1 : -1))
      setMsgs(list)
    } finally { setLoading(false) }
  }, [item, msgs, loading])
  if (!msgs && !loading) load()
  if (loading) return <div className="flex items-center gap-2 text-xs text-neutral-400 py-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
  if (!msgs || msgs.length === 0) return <div className="text-xs text-neutral-400 py-1">No earlier messages.</div>
  return (
    <div className="space-y-1.5 max-h-56 overflow-y-auto py-1">
      {msgs.slice(0, 15).map((m) => (
        <div key={m.id} className={`text-sm rounded-lg px-3 py-2 ${m.direction === 'in' ? 'bg-neutral-100 text-neutral-800' : 'bg-[#cd2653]/5 text-neutral-700'}`}>
          <div className="flex items-center justify-between gap-3 mb-0.5"><span className="text-[11px] font-medium text-neutral-500">{m.direction === 'in' ? item.title : 'You / team'}</span><span className="text-[11px] text-neutral-400">{fmtWhen(m.at)}</span></div>
          <div className="whitespace-pre-wrap break-words">{m.body}</div>
        </div>
      ))}
    </div>
  )
}

function Detail({ item, onDone, onClose }: { item: TodoItem; onDone: () => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const a = item.action

  const send = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      let r: { ok: boolean; data: { error?: string; message?: string } }
      if (a.type === 'reply' && a.channel === 'whatsapp') r = await postJSON('/api/admin/inbox/unified/reply', { channel: 'whatsapp', mode: 'text', phone: a.phone, text })
      else if (a.type === 'reply' && a.channel === 'email') r = await postJSON('/api/admin/inbox/unified/reply', { channel: 'email', mode: 'text', email: a.email, subject: a.subject || undefined, text })
      else if (a.type === 'reply_portal') r = await postJSON(`/api/admin/support/${a.applicationId}/reply`, { body: text })
      else { setBusy(false); return }
      if (!r.ok) { setErr(r.data?.message || r.data?.error || 'Could not send.'); return }
      onDone()
    } finally { setBusy(false) }
  }, [a, text, onDone])

  const confirmEft = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      const r = await postJSON('/api/admin/eft-proofs/confirm', { applicationId: (a as { applicationId: string }).applicationId })
      if (!r.ok) { setErr(r.data?.error || 'Could not confirm.'); return }
      onDone()
    } finally { setBusy(false) }
  }, [a, onDone])

  return (
    <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm text-neutral-700">{item.whatsNeeded}</div>
        <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-4 h-4" /></button>
      </div>
      {a.type === 'confirm_eft' ? (
        <div className="mt-3 space-y-2">
          <div className="text-sm text-neutral-600">Ref <b>{a.reference}</b> · <b>R{a.amount.toLocaleString('en-ZA')}</b></div>
          {a.proofUrl && <a href={a.proofUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-[#cd2653] hover:underline font-medium"><ExternalLink className="w-3.5 h-3.5" /> Open the proof</a>}
          <button onClick={confirmEft} disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-sm font-medium px-4 py-2">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Confirm paid</button>
        </div>
      ) : (a.type === 'reply' || a.type === 'reply_portal') ? (
        <div className="mt-3 space-y-2">
          <Thread item={item} />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={`Reply to ${item.title}…`} className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#cd2653]/30" />
          <div className="flex items-center gap-3">
            <button onClick={send} disabled={busy || !text.trim()} className="flex items-center gap-2 rounded-lg bg-[#cd2653] hover:bg-[#b31f48] disabled:opacity-60 text-white text-sm font-medium px-4 py-2">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send</button>
            <a href={item.href} className="text-xs text-neutral-400 hover:text-neutral-600">Full conversation</a>
          </div>
        </div>
      ) : (
        <a href={item.href} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[#cd2653] hover:underline">Open <ChevronRight className="w-3.5 h-3.5" /></a>
      )}
      {err && <div className="text-sm text-red-600 mt-2">{err}</div>}
    </div>
  )
}

function SectionCard({ section, onDone }: { section: Todo['sections'][number]; onDone: () => void }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const tone = TONE[section.key] ?? TONE.task
  const isNav = section.items[0]?.action.type === 'navigate'
  return (
    <div className="card rounded-2xl border border-neutral-200 bg-white p-4 flex flex-col">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">{section.label}</h3>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${tone.pill}`}>{section.items.length}</span>
      </div>
      <ul className="mt-1 divide-y divide-neutral-100">
        {section.items.map((it, i) => (
          <li key={`${section.key}-${i}`}>
            <button onClick={() => setOpenIdx(openIdx === i ? null : i)} className="w-full flex items-center gap-3 py-2.5 text-left">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-neutral-900 truncate">{it.title}</div>
                {it.ask && <div className="text-xs text-neutral-500 truncate">{it.ask}</div>}
              </div>
              {it.since && <span className="text-[11px] text-neutral-400 shrink-0">{ago(it.since)}</span>}
              <ChevronRight className={`w-4 h-4 shrink-0 text-neutral-300 transition-transform ${openIdx === i ? 'rotate-90' : ''}`} />
            </button>
            {openIdx === i && <Detail item={it} onDone={() => { setOpenIdx(null); onDone() }} onClose={() => setOpenIdx(null)} />}
          </li>
        ))}
      </ul>
      {isNav && (
        <a href={section.items[0].href} className="mt-2 text-xs font-medium text-neutral-500 hover:text-neutral-800">Open all →</a>
      )}
    </div>
  )
}

export function TodoClient({ initial }: { initial: Todo }) {
  const [todo, setTodo] = useState(initial)
  const refresh = useCallback(async () => {
    const res = await fetch('/api/admin/todo')
    if (res.ok) setTodo(await res.json())
  }, [])
  const visible = todo.sections.filter((s) => s.items.length > 0)
  if (todo.total === 0) return <div className="rounded-2xl border border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-500">All caught up. Nothing needs you right now.</div>
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wider text-neutral-400 mb-3">Needs you</div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {visible.map((s) => <SectionCard key={s.key} section={s} onDone={refresh} />)}
      </div>
    </div>
  )
}
