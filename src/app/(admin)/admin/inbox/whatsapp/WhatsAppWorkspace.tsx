'use client'

/**
 * WhatsApp workspace. One channel, full width, nothing shared with the mail
 * surfaces (Taona, 2026-07-27: "they should not communicate and be aware").
 *
 * It reads /api/admin/inbox/channel/whatsapp, whose loader applies the EFT lane
 * seal itself, so this component has no visibility rules of its own to get wrong.
 * Thread messages and replies reuse the existing unified endpoints, which are
 * already sealed and already understand `phone` — there is no reason to build a
 * second pair.
 *
 * NO "Needs You" TAB. Chats awaiting a human are PINNED to the top of this list
 * until answered ("when a human is needed that chat must be pinned to the top of
 * the chats until resolved instead of needs you"). The pin is computed from HUMAN
 * replies, so the bot answering does not clear it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AdminPage } from '@/components/admin/AdminPage'
import { WhatsAppStream } from '@/components/admin/inbox/WhatsAppStream'
import { createClient } from '@/lib/supabase/client'
import { fmtSAST, initials } from '@/lib/inbox/format'
import type { CommItem } from '@/lib/inbox/types'
import type { ChannelThread } from '@/lib/inbox/channel-threads'
import { Search, Send, Loader2, Pin } from 'lucide-react'

export function WhatsAppWorkspace() {
  const [threads, setThreads] = useState<ChannelThread[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CommItem[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const threadsRef = useRef<ChannelThread[]>([])
  const activeIdRef = useRef<string | null>(null)
  const streamEnd = useRef<HTMLDivElement>(null)
  threadsRef.current = threads
  activeIdRef.current = activeId

  const active = threads.find((t) => t.id === activeId) || null

  const loadThreads = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await fetch('/api/admin/inbox/channel/whatsapp', { cache: 'no-store' })
      if (!r.ok) throw new Error(r.status === 403 ? 'Not permitted' : `Failed to load (${r.status})`)
      const j = await r.json()
      setThreads(j.threads || [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMessages = useCallback(async (t: ChannelThread) => {
    if (!t.phone) return
    const r = await fetch(`/api/admin/inbox/unified/messages?phone=${encodeURIComponent(t.phone)}`, { cache: 'no-store' })
    if (!r.ok) { setMessages([]); return }
    const j = await r.json()
    setMessages((j.messages || []).filter((m: CommItem) => m.channel === 'whatsapp'))
  }, [])

  useEffect(() => { loadThreads() }, [loadThreads])

  // Realtime, same broadcast channel the webhook and mail fetchers already ping.
  useEffect(() => {
    const supabase = createClient()
    const ch = supabase
      .channel('inbox-updates')
      .on('broadcast', { event: 'refresh' }, () => {
        loadThreads(true)
        const t = threadsRef.current.find((x) => x.id === activeIdRef.current)
        if (t) loadMessages(t)
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [loadThreads, loadMessages])

  // Safety net if the socket drops.
  useEffect(() => {
    const id = setInterval(() => loadThreads(true), 30000)
    return () => clearInterval(id)
  }, [loadThreads])

  useEffect(() => { streamEnd.current?.scrollIntoView({ block: 'end' }) }, [messages])

  function open(t: ChannelThread) {
    setActiveId(t.id)
    setMessages([])
    loadMessages(t)
  }

  async function send() {
    const text = draft.trim()
    if (!text || !active?.phone || sending) return
    setSending(true)
    const optimistic: CommItem = {
      id: `pending-${crypto.randomUUID()}`, channel: 'whatsapp', direction: 'out',
      body: text, at: new Date().toISOString(), from: 'You', pending: true,
    }
    setMessages((m) => [...m, optimistic])
    setDraft('')
    try {
      const r = await fetch('/api/admin/inbox/unified/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'whatsapp', phone: active.phone, text }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.ok === false) throw new Error(j.message || j.reason || `Send failed (${r.status})`)
      await loadMessages(active)
      loadThreads(true)
    } catch (e) {
      setError((e as Error).message)
      setMessages((m) => m.filter((x) => x.id !== optimistic.id))
      setDraft(text)
    } finally {
      setSending(false)
    }
  }

  const needle = q.trim().toLowerCase()
  const shown = needle
    ? threads.filter((t) =>
        [t.business_name, t.peer_name, t.phone, t.last_preview]
          .some((f) => (f || '').toLowerCase().includes(needle)))
    : threads
  const pinnedCount = threads.filter((t) => t.needs_response).length

  return (
    <AdminPage
      fill
      caption="COMMUNICATIONS"
      title="WhatsApp"
      subtitle={pinnedCount > 0
        ? `${pinnedCount} waiting on a person, pinned to the top.`
        : 'Nobody is waiting on a reply.'}
    >
      <div className="flex h-full min-h-0 gap-4">
        {/* ── Thread list ─────────────────────────────────────────────── */}
        <aside className="w-[340px] shrink-0 flex flex-col min-h-0 rounded-xl border border-neutral-200 bg-white">
          <div className="p-2 border-b border-neutral-200">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search WhatsApp"
                className="w-full pl-8 pr-3 py-2 text-sm rounded-lg bg-neutral-100 focus:bg-white focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && <p className="p-4 text-sm text-neutral-500">Loading…</p>}
            {!loading && shown.length === 0 && (
              <p className="p-4 text-sm text-neutral-500">
                {needle ? 'No conversations match.' : 'No WhatsApp conversations.'}
              </p>
            )}
            {shown.map((t, i) => {
              // The pin IS the queue. A divider marks where waiting ends, so the
              // boundary is visible without a separate page to visit.
              const prev = shown[i - 1]
              const boundary = i > 0 && prev.needs_response && !t.needs_response
              return (
                <div key={t.id}>
                  {boundary && (
                    <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400 border-t border-neutral-100">
                      Answered
                    </div>
                  )}
                  <button
                    onClick={() => open(t)}
                    className={`w-full text-left px-3 py-2.5 flex gap-3 border-b border-neutral-100 transition-colors ${
                      t.id === activeId ? 'bg-neutral-100' : 'hover:bg-neutral-50'
                    }`}
                  >
                    <div className="h-9 w-9 shrink-0 rounded-full bg-emerald-100 text-emerald-800 grid place-items-center text-xs font-semibold">
                      {initials(t.business_name || t.peer_name || t.phone || '?')}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {t.needs_response && <Pin className="h-3 w-3 shrink-0 text-rose-600" aria-label="Waiting on a person" />}
                        <span className="truncate text-sm font-medium text-neutral-900">
                          {t.business_name || t.peer_name || t.phone}
                        </span>
                        <span className="ml-auto shrink-0 text-[11px] text-neutral-400">
                          {t.last_message_at ? fmtSAST(t.last_message_at) : ''}
                        </span>
                      </div>
                      <p className={`truncate text-xs ${t.unread ? 'text-neutral-900 font-medium' : 'text-neutral-500'}`}>
                        {t.last_direction === 'out' ? 'You: ' : ''}{t.last_preview || 'No messages'}
                      </p>
                    </div>
                  </button>
                </div>
              )
            })}
          </div>
        </aside>

        {/* ── Thread ──────────────────────────────────────────────────── */}
        <section className="flex-1 min-w-0 flex flex-col min-h-0 rounded-xl border border-neutral-200 bg-white">
          {!active && (
            <div className="flex-1 grid place-items-center text-sm text-neutral-500">
              Pick a conversation.
            </div>
          )}

          {active && (
            <>
              <header className="px-4 py-3 border-b border-neutral-200 flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-emerald-100 text-emerald-800 grid place-items-center text-xs font-semibold">
                  {initials(active.business_name || active.peer_name || active.phone || '?')}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-neutral-900">
                    {active.business_name || active.peer_name || active.phone}
                  </p>
                  <p className="truncate text-xs text-neutral-500">{active.phone}</p>
                </div>
                {active.needs_response && (
                  <span className="ml-auto text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5">
                    Waiting on a person
                  </span>
                )}
              </header>

              <div className="flex-1 overflow-y-auto px-4 bg-[#efeae2]">
                <WhatsAppStream messages={messages} />
                <div ref={streamEnd} />
              </div>

              <footer className="p-3 border-t border-neutral-200">
                {error && <p className="mb-2 text-xs text-rose-600">{error}</p>}
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                    }}
                    rows={1}
                    placeholder="Write a message"
                    className="flex-1 resize-none px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 max-h-40"
                  />
                  <button
                    onClick={send}
                    disabled={!draft.trim() || sending}
                    className="h-9 w-9 grid place-items-center rounded-lg bg-neutral-900 text-white disabled:opacity-40"
                    aria-label="Send"
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>
    </AdminPage>
  )
}
