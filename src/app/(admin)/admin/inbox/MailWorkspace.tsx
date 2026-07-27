'use client'

/**
 * Mail workspace, used by BOTH /admin/inbox/support and /admin/inbox/gmail.
 *
 * Sharing a COMPONENT is not the thing Taona objected to. What kept breaking was
 * one merged LIST filtered three ways, where a change made for email broke
 * WhatsApp because they shared state at runtime. These two pages share only
 * rendering code: each mounts with its own `mailbox`, calls its own endpoint,
 * holds its own state, and neither can see the other's threads. The alternative
 * is 250 duplicated lines that drift, which is the failure this refactor exists
 * to end.
 *
 * Email renders as MAIL, not chat: full-width cards, sender and date per message,
 * the quoted tail collapsed behind a toggle. That is EmailThread, already written.
 *
 * Replies go through the existing unified endpoint, which resolves the sending
 * mailbox from the RECIPIENT (mailboxForPeer), so a Gmail thread is answered from
 * Gmail and a support@ thread from support@ without this component choosing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AdminPage } from '@/components/admin/AdminPage'
import { EmailThread } from '@/components/admin/inbox/EmailThread'
import { createClient } from '@/lib/supabase/client'
import { fmtSAST, initials } from '@/lib/inbox/format'
import type { CommItem } from '@/lib/inbox/types'
import type { ChannelThread, MailBox } from '@/lib/inbox/channel-threads'
import { Search, Send, Loader2, Pin } from 'lucide-react'
import { ThreadToolbar } from '@/components/admin/inbox/ThreadToolbar'

interface Props {
  mailbox: MailBox
  title: string
  subtitle: string
  /** Which address these replies go out from, shown so the operator is never
   *  guessing which identity she is answering as. */
  sendingAs: string
}

export function MailWorkspace({ mailbox, title, subtitle, sendingAs }: Props) {
  const [threads, setThreads] = useState<ChannelThread[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CommItem[]>([])
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'waiting' | 'unread'>('all')
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
      const r = await fetch(`/api/admin/inbox/channel/${mailbox}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(r.status === 403 ? 'Not permitted' : `Failed to load (${r.status})`)
      const j = await r.json()
      setThreads(j.threads || [])
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [mailbox])

  const loadMessages = useCallback(async (t: ChannelThread) => {
    if (!t.email) return
    const r = await fetch(`/api/admin/inbox/unified/messages?email=${encodeURIComponent(t.email)}`, { cache: 'no-store' })
    if (!r.ok) { setMessages([]); return }
    const j = await r.json()
    setMessages((j.messages || []).filter((m: CommItem) => m.channel === 'email'))
  }, [])

  useEffect(() => { loadThreads() }, [loadThreads])

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
    if (!text || !active?.email || sending) return
    setSending(true)
    const optimistic: CommItem = {
      id: `pending-${crypto.randomUUID()}`, channel: 'email', direction: 'out',
      body: text, at: new Date().toISOString(), from: 'You', pending: true,
      subject: active.subject || undefined,
    }
    setMessages((m) => [...m, optimistic])
    setDraft('')
    try {
      const r = await fetch('/api/admin/inbox/unified/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'email', email: active.email, text }),
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
        [t.business_name, t.peer_name, t.email, t.subject, t.last_preview]
          .some((f) => (f || '').toLowerCase().includes(needle)))
    : threads
  const shownFiltered = shown.filter((t) =>
    filter === 'waiting' ? t.needs_response : filter === 'unread' ? t.unread : true)
  const pinnedCount = threads.filter((t) => t.needs_response).length
  const unreadCount = threads.filter((t) => t.unread).length

  return (
    <AdminPage
      fill
      caption="COMMUNICATIONS"
      title={title}
      subtitle={pinnedCount > 0 ? `${pinnedCount} waiting on a reply, pinned to the top.` : subtitle}
    >
      <div className="flex h-full min-h-0 gap-4">
        {/* ── Thread list ─────────────────────────────────────────────── */}
        <aside className="w-[360px] shrink-0 flex flex-col min-h-0 rounded-xl border border-neutral-200 bg-white">
          <div className="p-2 border-b border-neutral-200">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${title}`}
                className="w-full pl-8 pr-3 py-2 text-sm rounded-lg bg-neutral-100 focus:bg-white focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
              />
            </div>
            {/* Filters. The old inbox had these and the new tabs shipped without
                them, so a 200-row list could only be read top to bottom. */}
            <div className="mt-2 flex items-center gap-1">
              {([
                ['all', 'All', threads.length],
                ['waiting', 'Waiting', pinnedCount],
                ['unread', 'Unread', unreadCount],
              ] as const).map(([k, label, n]) => (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                    filter === k ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
                  }`}
                >
                  {label} {n > 0 && <span className={filter === k ? 'opacity-70' : 'text-neutral-400'}>{n}</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && <p className="p-4 text-sm text-neutral-500">Loading…</p>}
            {!loading && shownFiltered.length === 0 && (
              <p className="p-4 text-sm text-neutral-500">
                {needle ? 'No conversations match.' : 'Nothing here.'}
              </p>
            )}
            {shownFiltered.map((t, i) => {
              const prev = shownFiltered[i - 1]
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
                    <div className="h-9 w-9 shrink-0 rounded-full bg-sky-100 text-sky-800 grid place-items-center text-xs font-semibold">
                      {initials(t.business_name || t.peer_name || t.email || '?')}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {t.needs_response && <Pin className="h-3 w-3 shrink-0 text-rose-600" aria-label="Waiting on a reply" />}
                        <span className="truncate text-sm font-medium text-neutral-900">
                          {t.business_name || t.peer_name || t.email}
                        </span>
                        <span className="ml-auto shrink-0 text-[11px] text-neutral-400">
                          {t.last_message_at ? fmtSAST(t.last_message_at) : ''}
                        </span>
                      </div>
                      {/* Subject, then snippet: the two lines Gmail shows, in that order. */}
                      <p className={`truncate text-xs ${t.unread ? 'text-neutral-900 font-medium' : 'text-neutral-700'}`}>
                        {t.subject || '(no subject)'}
                      </p>
                      <p className="truncate text-xs text-neutral-500">
                        {t.last_direction === 'out' ? 'You: ' : ''}{t.last_preview || ''}
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
              <header className="px-4 py-3 border-b border-neutral-200">
                <div className="flex items-center gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-neutral-900">
                      {active.subject || '(no subject)'}
                    </p>
                    <p className="truncate text-xs text-neutral-500">
                      {active.business_name || active.peer_name || ''}{active.business_name || active.peer_name ? ' · ' : ''}{active.email}
                    </p>
                  </div>
                <div className="ml-auto shrink-0 flex items-center gap-2">
                  {active.bot_paused && (
                    <span className="text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                      Bot paused
                    </span>
                  )}
                  {active.needs_response && (
                    <span className="text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5">
                      Waiting on a reply
                    </span>
                  )}
                  <ThreadToolbar
                    thread={active}
                    onChanged={() => loadThreads(true)}
                    onError={(m) => setError(m)}
                  />
                </div>
                </div>
              </header>

              <div className="flex-1 overflow-y-auto px-4 py-3">
                <EmailThread messages={messages} />
                <div ref={streamEnd} />
              </div>

              <footer className="p-3 border-t border-neutral-200">
                {error && <p className="mb-2 text-xs text-rose-600">{error}</p>}
                <p className="mb-1.5 text-[11px] text-neutral-500">
                  Replying as <span className="font-medium text-neutral-700">{sendingAs}</span>
                  {active.subject ? <> · <span className="text-neutral-600">Re: {active.subject.replace(/^re:\s*/i, '')}</span></> : null}
                </p>
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // Email is long-form: Enter makes a paragraph. Cmd/Ctrl+Enter sends.
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
                    }}
                    rows={4}
                    placeholder="Write a reply. Cmd+Enter to send."
                    className="flex-1 resize-y px-3 py-2 text-sm rounded-lg border border-neutral-200 focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
                  />
                  <button
                    onClick={send}
                    disabled={!draft.trim() || sending}
                    className="h-9 px-3 grid place-items-center rounded-lg bg-neutral-900 text-white disabled:opacity-40"
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
