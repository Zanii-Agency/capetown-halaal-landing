'use client'

// Needs You — a PURPOSE-BUILT triage surface, deliberately NOT the inbox shell.
// No channel tabs, no Unread/Open/Resolved, no search, no tag filter. Just the
// people awaiting a response, the conversation, and a reply box. Two modes:
//   SPLIT  — [ WAITING list ] | [ chat + reply ]   (default)
//   FOCUS  — [ chat + reply ] + ‹ prev  ● ○○○  next ›  (carousel, list hidden)
// Reuses the unified inbox pipes (list / messages / reply / status); owns only
// its own layout. Reply and Done both advance to the next waiting conversation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AdminPage } from '@/components/admin/AdminPage'
import { Loader2, Send, Check, ChevronLeft, ChevronRight, Maximize2, Minimize2, MessageCircle, Mail, Bell } from 'lucide-react'

interface Contact {
  id: string
  business_name: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  channels: Array<'whatsapp' | 'email'>
  last_message_at: string | null
  last_preview: string | null
  application_id: string | null
  needs_response: boolean
  last_channel: 'whatsapp' | 'email'
  mailbox: 'gmail' | 'youngatheart' | null
}

// The three channels a client reaches the festival on: WhatsApp, the
// support@youngatheart.co.za inbox, and Samreen's capetownhalaal Gmail. Badge
// each waiting item so she knows where to answer before opening it.
function channelInfo(c: Contact): { label: string; cls: string; wa: boolean } {
  const isWa = c.last_channel === 'whatsapp' || (c.channels.includes('whatsapp') && !c.channels.includes('email'))
  if (isWa) return { label: 'WhatsApp', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', wa: true }
  if (c.mailbox === 'gmail') return { label: 'Gmail', cls: 'text-rose-700 bg-rose-50 border-rose-200', wa: false }
  return { label: 'YAH email', cls: 'text-blue-700 bg-blue-50 border-blue-200', wa: false }
}
function ChannelBadge({ c }: { c: Contact }) {
  const info = channelInfo(c)
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${info.cls}`}>
      {info.wa ? <MessageCircle className="w-3 h-3" /> : <Mail className="w-3 h-3" />}{info.label}
    </span>
  )
}
interface CommItem {
  id: string
  channel: 'whatsapp' | 'email'
  direction: 'in' | 'out'
  bot?: boolean
  body: string
  at: string
  from: string
  media?: Array<{ kind: string; url: string | null; filename?: string }>
  pending?: boolean
}

const nameOf = (c: Contact) => c.business_name || c.contact_name || c.phone || c.email || 'Unknown'
const initials = (n: string) => {
  const p = n.trim().split(/\s+/).filter(Boolean)
  return p.length ? (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() : '?'
}
// "2h", "5m", "just now" — how long the last message has been waiting.
function waitLabel(iso: string | null): string {
  if (!iso) return ''
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg' }) } catch { return '' }
}

export function NeedsYouClient() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CommItem[]>([])
  const [msgsLoading, setMsgsLoading] = useState(false)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [sendMsg, setSendMsg] = useState<string | null>(null)
  const [windowClosed, setWindowClosed] = useState(false)
  const [focus, setFocus] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const waiting = useMemo(() => contacts.filter((c) => c.needs_response), [contacts])
  // Breakdown across the three client channels, shown in the top bar so it's
  // obvious the queue spans WhatsApp + both email inboxes.
  const breakdown = useMemo(() => {
    let wa = 0, gmail = 0, yah = 0
    for (const c of waiting) { const i = channelInfo(c); if (i.wa) wa++; else if (i.label === 'Gmail') gmail++; else yah++ }
    return { wa, gmail, yah }
  }, [waiting])
  const active = useMemo(() => contacts.find((c) => c.id === activeId) || null, [contacts, activeId])
  const pos = active ? waiting.findIndex((c) => c.id === active.id) : -1

  const loadList = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await fetch('/api/admin/inbox/unified?channel=all')
      const j = await res.json()
      if (res.ok) setContacts(j.contacts || [])
    } finally { setLoading(false) }
  }, [])

  // Refs so the realtime callback / poll read current state without re-subscribing.
  const activeIdRef = useRef<string | null>(null); activeIdRef.current = activeId
  const contactsRef = useRef<Contact[]>([]); contactsRef.current = contacts

  // Silent refetch of the OPEN thread's messages — appends new inbound/outbound
  // without disturbing scroll unless the count actually changed. This is what was
  // missing: the thread never refreshed while open, so new messages never streamed.
  const refreshOpenMessages = useCallback(async () => {
    const c = contactsRef.current.find((x) => x.id === activeIdRef.current)
    if (!c) return
    try {
      const params = new URLSearchParams()
      if (c.phone) params.set('phone', c.phone)
      if (c.email) params.set('email', c.email)
      const res = await fetch(`/api/admin/inbox/unified/messages?${params}`)
      const j = await res.json()
      if (res.ok) setMessages((prev) => {
        const next: CommItem[] = j.messages || []
        // By identity, not length — see the matching note in CustomerInboxClient.
        // This surface never calls loadMessages after a send, so the length guard
        // left the optimistic `pending` bubble stuck greyed-out indefinitely: the
        // 6s poll saw N+1 === N+1 and kept discarding the real row.
        const same =
          next.length === prev.length &&
          next.every((m, i) => m.id === prev[i]?.id && m.at === prev[i]?.at)
        if (same) return prev
        requestAnimationFrame(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight })
        return next
      })
    } catch { /* keep last good */ }
  }, [])

  const refreshNow = useCallback(() => {
    if (document.hidden) return
    loadList(true)
    refreshOpenMessages()
  }, [loadList, refreshOpenMessages])

  useEffect(() => { loadList() }, [loadList])

  // LIVE: same Supabase Realtime broadcast the main inbox uses — the WhatsApp
  // webhook fires a content-free "refresh" the instant a message lands, and we
  // re-fetch through the server route. Makes Needs You stream like the inbox.
  useEffect(() => {
    const supabase = createClient()
    const ch = supabase.channel('inbox-updates').on('broadcast', { event: 'refresh' }, () => refreshNow()).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [refreshNow])

  // Fallback poll (safety net if the socket drops): refresh the open thread every
  // 6s and the list every 15s, so streaming works even without the broadcast.
  useEffect(() => {
    const fast = setInterval(() => { if (!document.hidden) refreshOpenMessages() }, 6000)
    const slow = setInterval(() => { if (!document.hidden) loadList(true) }, 15000)
    return () => { clearInterval(fast); clearInterval(slow) }
  }, [refreshOpenMessages, loadList])

  // Always keep a waiting conversation open. When the open one is handled and
  // drops out of `waiting`, snap to the first still-waiting item.
  useEffect(() => {
    const stillOpen = activeId && waiting.some((c) => c.id === activeId)
    if (!stillOpen) setActiveId(waiting.length ? waiting[0].id : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts])

  const loadMessages = useCallback(async (c: Contact) => {
    setMsgsLoading(true); setSendMsg(null); setWindowClosed(false)
    try {
      const params = new URLSearchParams()
      if (c.phone) params.set('phone', c.phone)
      if (c.email) params.set('email', c.email)
      const res = await fetch(`/api/admin/inbox/unified/messages?${params}`)
      const j = await res.json()
      if (res.ok) {
        setMessages(j.messages || [])
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight
        }))
      }
    } finally { setMsgsLoading(false) }
  }, [])

  useEffect(() => {
    const c = contacts.find((x) => x.id === activeId)
    if (c) loadMessages(c)
    else setMessages([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    const ta = taRef.current
    if (ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px` }
  }, [reply, activeId])

  // Go to the next still-waiting conversation after handling one.
  const advance = useCallback((handledId: string) => {
    const order = waiting.filter((c) => c.id !== handledId)
    if (!order.length) { setActiveId(null); return }
    const from = waiting.findIndex((c) => c.id === handledId)
    const next = waiting.slice(from + 1).find((c) => c.id !== handledId) || order[0]
    setActiveId(next.id)
  }, [waiting])

  const replyChannel: 'whatsapp' | 'email' = active?.phone ? 'whatsapp' : 'email'

  const submitReply = useCallback(async (mode?: 'template') => {
    if (!active || !reply.trim()) return
    const text = reply.trim()
    const tempId = `temp:${Date.now()}`
    setMessages((prev) => [...prev, { id: tempId, channel: replyChannel, direction: 'out', body: text, at: new Date().toISOString(), from: 'You', pending: true }])
    setReply(''); setSending(true); setSendMsg(null)
    try {
      const res = await fetch('/api/admin/inbox/unified/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: replyChannel, mode, phone: replyChannel === 'whatsapp' ? active.phone : undefined, email: replyChannel === 'email' ? active.email : undefined, text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.ok === false) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId)); setReply(text)
        setSendMsg(j.message || j.error || 'Send failed.')
        if (j.windowClosed) setWindowClosed(true)
        return
      }
      setWindowClosed(false)
      const handled = active.id
      await loadList(true)
      advance(handled)
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== tempId)); setReply(text); setSendMsg('Send failed.')
    } finally { setSending(false) }
  }, [active, reply, replyChannel, loadList, advance])

  // Mark handled without replying (resolve) and move on.
  const markDone = useCallback(async () => {
    if (!active) return
    const handled = active.id
    setContacts((prev) => prev.map((c) => (c.id === handled ? { ...c, needs_response: false } : c)))
    advance(handled)
    try {
      await fetch('/api/admin/inbox/unified/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', applicationId: active.application_id || undefined, phone: active.phone || undefined, email: active.email || undefined }),
      })
    } catch { /* optimistic */ }
  }, [active, advance])

  const goPrev = () => { if (pos > 0) setActiveId(waiting[pos - 1].id) }
  const goNext = () => { if (pos >= 0 && pos < waiting.length - 1) setActiveId(waiting[pos + 1].id) }

  // ---------- render pieces ----------
  const conversation = (
    <div className="flex flex-col min-h-0 flex-1">
      {!active ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
          <Check className="w-8 h-8 text-emerald-500 mb-3" />
          <p className="text-sm font-semibold text-neutral-700">You&apos;re all caught up.</p>
          <p className="text-xs text-neutral-400 mt-0.5">Nobody is awaiting a response right now.</p>
        </div>
      ) : (
        <>
          {/* Who + how long they've waited */}
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-neutral-100 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-full bg-[#cd2653]/10 text-[#cd2653] flex items-center justify-center text-sm font-bold shrink-0">{initials(nameOf(active))}</div>
              <div className="min-w-0">
                <p className="font-serif text-base text-neutral-900 leading-tight truncate">{nameOf(active)}</p>
                <div className="flex items-center gap-2 text-xs text-neutral-500 mt-1 flex-wrap">
                  <ChannelBadge c={active} />
                  {active.phone && <span className="inline-flex items-center gap-1">{active.phone}</span>}
                  {active.email && <span className="inline-flex items-center gap-1 truncate max-w-[220px]">{active.email}</span>}
                  {active.last_message_at && <span className="text-amber-600 font-semibold">waiting {waitLabel(active.last_message_at)}</span>}
                </div>
              </div>
            </div>
            <button onClick={markDone} title="Mark handled and move to the next"
              className="h-8 px-2.5 rounded-lg border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 flex items-center gap-1 text-[11px] font-semibold text-emerald-700 shrink-0">
              <Check className="w-3.5 h-3.5" />Done
            </button>
          </div>

          {/* Thread */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-5 py-4 space-y-2 bg-neutral-50/40">
            {msgsLoading ? (
              <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-neutral-400" /></div>
            ) : messages.length === 0 ? (
              <p className="text-center text-xs text-neutral-400 py-8">No messages yet.</p>
            ) : messages.map((m) => (
              <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${m.direction === 'out' ? 'bg-[#cd2653] text-white' : 'bg-white border border-neutral-200 text-neutral-800'} ${m.pending ? 'opacity-60' : ''}`}>
                  {m.direction === 'out' && (m.bot ? <span className="block text-[10px] font-semibold opacity-80 mb-0.5">Bot</span> : null)}
                  {(m.media || []).map((md, i) => md.url && md.kind === 'image'
                    ? <img key={i} src={md.url} alt="" className="rounded-lg max-w-full mb-1" />
                    : <span key={i} className="block text-[11px] opacity-80 mb-0.5">📎 {md.filename || md.kind}</span>)}
                  <span className="whitespace-pre-wrap break-words">{m.body}</span>
                  <span className={`block text-[10px] mt-1 ${m.direction === 'out' ? 'text-white/70' : 'text-neutral-400'}`}>{fmtTime(m.at)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Reply */}
          <div className="border-t border-neutral-100 px-4 py-3 shrink-0">
            {sendMsg && <p className="text-[11px] text-rose-600 mb-2">{sendMsg}</p>}
            <div className="flex items-end gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 focus-within:border-[#cd2653]">
              <textarea ref={taRef} value={reply} onChange={(e) => setReply(e.target.value)} rows={1}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitReply() } }}
                placeholder={`Reply via ${replyChannel}…`}
                className="flex-1 resize-none py-1.5 text-sm outline-none bg-transparent leading-relaxed" />
              <button onClick={() => submitReply()} disabled={sending || !reply.trim()}
                className="w-9 h-9 rounded-lg bg-[#cd2653] text-white hover:bg-[#b31f47] disabled:opacity-50 flex items-center justify-center self-center shrink-0">
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
            {windowClosed && (
              <button onClick={() => submitReply('template')} disabled={sending || !reply.trim()}
                className="mt-2 text-[11px] font-semibold text-[#cd2653] hover:underline disabled:opacity-50">
                Outside the 24h window — send as approved announcement instead
              </button>
            )}
            {focus && active && (
              <div className="flex items-center justify-center gap-4 mt-3">
                <button onClick={goPrev} disabled={pos <= 0} className="w-8 h-8 rounded-lg border border-neutral-200 hover:bg-neutral-100 flex items-center justify-center disabled:opacity-40"><ChevronLeft className="w-4 h-4 text-neutral-600" /></button>
                <div className="flex items-center gap-1.5">
                  {waiting.slice(0, 12).map((c, i) => <span key={c.id} className={`w-1.5 h-1.5 rounded-full ${i === pos ? 'bg-[#cd2653]' : 'bg-neutral-300'}`} />)}
                  {waiting.length > 12 && <span className="text-[10px] text-neutral-400 ml-1">+{waiting.length - 12}</span>}
                </div>
                <button onClick={goNext} disabled={pos < 0 || pos >= waiting.length - 1} className="w-8 h-8 rounded-lg border border-neutral-200 hover:bg-neutral-100 flex items-center justify-center disabled:opacity-40"><ChevronRight className="w-4 h-4 text-neutral-600" /></button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )

  return (
    <AdminPage fill title="Needs You" caption="ACTION QUEUE" subtitle="Everyone awaiting a response, in one place. Reply and move to the next.">
      <div className="flex flex-col h-[calc(100dvh-6rem)] lg:h-full">
        {/* Top bar: count + Focus toggle */}
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border border-neutral-200 rounded-t-2xl bg-rose-50/70 shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Bell className="w-4 h-4 text-[#cd2653]" />
            <span className="text-sm font-bold text-[#cd2653]">{waiting.length} waiting</span>
            {/* Always show all three channels (even at 0) so it's clear the queue
                covers WhatsApp + both email inboxes at a glance. */}
            <span className="text-[11px] font-medium text-neutral-500 flex items-center gap-2">
              <span className="inline-flex items-center gap-1"><MessageCircle className="w-3 h-3 text-emerald-600" />{breakdown.wa} WhatsApp</span>
              <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3 text-blue-600" />{breakdown.yah} YAH</span>
              <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3 text-rose-500" />{breakdown.gmail} Gmail</span>
            </span>
            {pos >= 0 && <span className="text-[11px] font-semibold text-rose-700/70">· on {pos + 1} of {waiting.length}</span>}
          </div>
          <button onClick={() => setFocus((v) => !v)}
            className="h-7 px-2.5 rounded-lg border border-rose-200 bg-white hover:bg-rose-100 flex items-center gap-1 text-[11px] font-semibold text-[#cd2653]">
            {focus ? <><Minimize2 className="w-3.5 h-3.5" />Show list</> : <><Maximize2 className="w-3.5 h-3.5" />Focus</>}
          </button>
        </div>

        <div className={`grid ${focus ? 'grid-cols-1' : 'lg:grid-cols-[300px_1fr]'} flex-1 min-h-0 border-x border-b border-neutral-200 rounded-b-2xl overflow-hidden bg-white`}>
          {/* WAITING list — minimal, only in split mode */}
          {!focus && (
            <aside className="border-r border-neutral-200 flex flex-col min-h-0 bg-neutral-50/50">
              <div className="px-4 py-2.5 border-b border-neutral-100 text-[11px] font-bold uppercase tracking-wider text-neutral-500 shrink-0">Waiting ({waiting.length})</div>
              <div className="flex-1 overflow-y-auto min-h-0">
                {loading ? (
                  <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-neutral-400" /></div>
                ) : waiting.length === 0 ? (
                  <div className="px-4 py-10 text-center"><Check className="w-6 h-6 text-emerald-500 mx-auto mb-2" /><p className="text-xs text-neutral-400">All caught up.</p></div>
                ) : (
                  <div className="divide-y divide-neutral-100">
                    {waiting.map((c) => {
                      const isActive = active?.id === c.id
                      return (
                        <button key={c.id} onClick={() => setActiveId(c.id)}
                          className={`w-full text-left px-4 py-3 flex items-start gap-2.5 ${isActive ? 'bg-[#cd2653]/5' : 'hover:bg-white'}`}>
                          <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${isActive ? 'bg-[#cd2653]' : 'bg-amber-400'}`} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-semibold text-neutral-800 truncate">{nameOf(c)}</p>
                              <span className="text-[10px] text-amber-600 font-semibold shrink-0">{waitLabel(c.last_message_at)}</span>
                            </div>
                            <p className="text-xs text-neutral-500 truncate mt-0.5">{c.last_preview || c.phone || c.email || ''}</p>
                            <div className="mt-1.5"><ChannelBadge c={c} /></div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </aside>
          )}
          {conversation}
        </div>
      </div>
    </AdminPage>
  )
}
