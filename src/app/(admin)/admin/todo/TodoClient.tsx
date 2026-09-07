'use client'

import { useCallback, useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, Send } from 'lucide-react'
import type { Todo, TodoItem } from '@/lib/todo'

type Msg = { id: string; channel?: string; direction: 'in' | 'out'; body: string; at: string; from?: string }

function ago(iso: string | null): string {
  if (!iso) return ''
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 36e5)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
const fmtWhen = (iso: string) => { try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

async function postJSON(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok && data?.ok !== false && !data?.error, data }
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
      list.sort((a, b) => (a.at < b.at ? 1 : -1)) // recent first, going back
      setMsgs(list)
    } finally { setLoading(false) }
  }, [item, msgs, loading])
  // load on first render of the expanded body
  if (!msgs && !loading) load()
  if (loading) return <div className="flex items-center gap-2 text-sm text-neutral-400 py-3"><Loader2 className="w-4 h-4 animate-spin" /> Loading recent messages…</div>
  if (!msgs || msgs.length === 0) return <div className="text-sm text-neutral-400 py-2">No earlier messages on this channel.</div>
  return (
    <div className="space-y-2 max-h-72 overflow-y-auto py-1">
      {msgs.slice(0, 20).map((m) => (
        <div key={m.id} className={`text-sm rounded-lg px-3 py-2 ${m.direction === 'in' ? 'bg-neutral-100 text-neutral-800' : 'bg-[#cd2653]/5 text-neutral-700'}`}>
          <div className="flex items-center justify-between gap-3 mb-0.5">
            <span className="text-xs font-medium text-neutral-500">{m.direction === 'in' ? (item.title || 'Them') : 'You / team'}</span>
            <span className="text-xs text-neutral-400">{fmtWhen(m.at)}</span>
          </div>
          <div className="whitespace-pre-wrap break-words">{m.body}</div>
        </div>
      ))}
    </div>
  )
}

function Card({ item, onDone }: { item: TodoItem; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const a = item.action

  // Operational task: a thing to DO, not a message. Render a clickable card that
  // navigates to the page where she does it. No thread, no reply box.
  if (a.type === 'navigate') {
    return (
      <li>
        <a href={a.href} className="flex items-center gap-3 px-5 py-3 hover:bg-neutral-50">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-neutral-900">{item.title}</div>
            <div className="text-sm text-neutral-500 mt-0.5">{item.whatsNeeded}</div>
          </div>
          <ChevronRight className="w-4 h-4 shrink-0 text-neutral-400" />
        </a>
      </li>
    )
  }

  const send = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      let r: { ok: boolean; data: { error?: string; message?: string } }
      if (a.type === 'reply' && a.channel === 'whatsapp') r = await postJSON('/api/admin/inbox/unified/reply', { channel: 'whatsapp', mode: 'text', phone: a.phone, text })
      else if (a.type === 'reply' && a.channel === 'email') r = await postJSON('/api/admin/inbox/unified/reply', { channel: 'email', mode: 'text', email: a.email, subject: a.subject || undefined, text })
      else if (a.type === 'reply_portal') r = await postJSON(`/api/admin/support/${a.applicationId}/reply`, { body: text })
      else { setBusy(false); return }
      if (!r.ok) { setErr(r.data?.message || r.data?.error || 'Could not send. Try again.'); return }
      onDone()
    } finally { setBusy(false) }
  }, [a, text, onDone])

  const confirmEft = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      const r = await postJSON('/api/admin/eft-proofs/confirm', { applicationId: (a as { applicationId: string }).applicationId })
      if (!r.ok) { setErr(r.data?.error || 'Could not confirm. Try again.'); return }
      onDone()
    } finally { setBusy(false) }
  }, [a, onDone])

  return (
    <li className="px-5 py-3">
      <button onClick={() => setOpen((o) => !o)} className="flex items-start gap-3 w-full text-left">
        <ChevronDown className={`w-4 h-4 mt-1 shrink-0 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-neutral-900 truncate">{item.title}</span>
            <span className="shrink-0 text-xs text-neutral-400 tabular-nums">{ago(item.since)}</span>
          </div>
          <div className="text-sm text-neutral-700 mt-0.5">{item.whatsNeeded}</div>
          {item.ask && <div className="text-sm text-neutral-500 mt-0.5 truncate italic">“{item.ask}”</div>}
        </div>
      </button>

      {open && (
        <div className="pl-7 pt-3 space-y-3">
          {a.type === 'confirm_eft' ? (
            <div className="space-y-3">
              <div className="text-sm text-neutral-600">Reference <span className="font-medium">{a.reference}</span> · Amount <span className="font-medium">R{a.amount.toLocaleString('en-ZA')}</span></div>
              {a.proofUrl && <a href={a.proofUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-[#cd2653] hover:underline font-medium"><ExternalLink className="w-3.5 h-3.5" /> Open the proof</a>}
              <div>
                <button onClick={confirmEft} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-sm font-medium px-4 py-2">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Confirm paid, R{a.amount.toLocaleString('en-ZA')}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Thread item={item} />
              <div>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={a.type === 'reply_portal' ? 'Answer the vendor…' : `Reply to ${item.title}…`} className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#cd2653]/30" />
                <div className="flex items-center gap-3 mt-2">
                  <button onClick={send} disabled={busy || !text.trim()} className="inline-flex items-center gap-2 rounded-lg bg-[#cd2653] hover:bg-[#b31f48] disabled:opacity-60 text-white text-sm font-medium px-4 py-2">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send {a.type === 'reply' && a.channel === 'whatsapp' ? 'WhatsApp' : a.type === 'reply' ? 'email' : 'reply'}
                  </button>
                  <a href={item.href} className="text-xs text-neutral-400 hover:text-neutral-600">Open full conversation</a>
                </div>
              </div>
            </div>
          )}
          {err && <div className="text-sm text-red-600">{err}</div>}
        </div>
      )}
    </li>
  )
}

export function TodoClient({ initial }: { initial: Todo }) {
  const [todo, setTodo] = useState(initial)
  const refresh = useCallback(async () => {
    const res = await fetch('/api/admin/todo')
    if (res.ok) setTodo(await res.json())
  }, [])
  const visible = todo.sections.filter((s) => s.items.length > 0)
  return (
    <div className="space-y-6">
      {visible.map((s) => (
        <section key={s.key} className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
          <header className="flex items-center justify-between px-5 py-3 border-b border-neutral-100">
            <h2 className="text-sm font-semibold text-neutral-800">{s.label}</h2>
            <span className="text-xs font-medium text-neutral-500">{s.items.length}</span>
          </header>
          <ul className="divide-y divide-neutral-100">
            {s.items.map((it, i) => <Card key={`${s.key}-${i}-${it.applicationId || it.phone || it.email}`} item={it} onDone={refresh} />)}
          </ul>
        </section>
      ))}
      {todo.total === 0 && <div className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-500">All caught up. Nothing needs you right now.</div>}
    </div>
  )
}
