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
import { useSearchParams } from 'next/navigation'
import { AdminPage } from '@/components/admin/AdminPage'
import { WhatsAppStream } from '@/components/admin/inbox/WhatsAppStream'
import { createClient } from '@/lib/supabase/client'
import { fmtSAST, initials } from '@/lib/inbox/format'
import type { CommItem } from '@/lib/inbox/types'
import type { ChannelThread } from '@/lib/inbox/channel-threads'
import { Search, Pin, Loader2 } from 'lucide-react'
import { ThreadToolbar } from '@/components/admin/inbox/ThreadToolbar'
import { Composer } from '@/components/admin/inbox/Composer'
import { VendorPanel } from '@/components/admin/inbox/VendorPanel'

export function WhatsAppWorkspace() {
  const [threads, setThreads] = useState<ChannelThread[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CommItem[]>([])
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'waiting' | 'unread'>('all')
  /** Thread keys (phone / email) whose MESSAGE BODIES match the query. The list
   *  filter only ever saw names, subjects and the one-line preview, so searching
   *  for something a vendor actually said found nothing. */
  const [bodyHits, setBodyHits] = useState<Set<string>>(new Set())
  const [panelOpen, setPanelOpen] = useState(false)
  const searchParams = useSearchParams()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The thread pane needs THREE distinct states. It had one: `messages`. Any
  // failure did setMessages([]) and rendered an empty room, so a 403, a dropped
  // network and "this vendor has never written" all looked identical — which is
  // most of what "it's not showing the messages" meant.
  const [msgLoading, setMsgLoading] = useState(false)
  const [msgError, setMsgError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const threadsRef = useRef<ChannelThread[]>([])
  const activeIdRef = useRef<string | null>(null)
  const streamEnd = useRef<HTMLDivElement>(null)
  const scrollBox = useRef<HTMLDivElement>(null)
  /** Only auto-scroll when the operator is already at the bottom. Scrolling on
   *  EVERY change yanked her out of the history she was reading whenever any
   *  message landed anywhere. Both old surfaces guard this; this one did not. */
  const stickToBottom = useRef(true)
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

  const loadMessages = useCallback(async (t: ChannelThread, opts?: { silent?: boolean }) => {
    if (!t.phone) return
    if (!opts?.silent) { setMsgLoading(true); setMsgError(null) }
    try {
      const r = await fetch(`/api/admin/inbox/unified/messages?phone=${encodeURIComponent(t.phone)}`, { cache: 'no-store' })
      if (r.status === 403) throw new Error('This conversation is outside your lane.')
      if (!r.ok) throw new Error(`Could not load this conversation (${r.status})`)
      const j = await r.json()
      const next: CommItem[] = j.messages || []
      setHasMore(!!j.pagination?.hasMore)
      // Replace only when something actually changed, so a poll does not blow
      // the list away and re-render the whole thread under the cursor.
      setMessages((prev) =>
        prev.length === next.length && prev[prev.length - 1]?.id === next[next.length - 1]?.id ? prev : next)
      setMsgError(null)
    } catch (e) {
      setMsgError((e as Error).message)
      if (!opts?.silent) setMessages([])
    } finally {
      setMsgLoading(false)
    }
  }, [])

  /** Walk further back in history. Two live threads hold 600+ messages, all of
   *  which were unreachable before this. */
  const loadOlder = useCallback(async () => {
    const t = threadsRef.current.find((x) => x.id === activeIdRef.current)
    const oldest = messages[0]?.at
    if (!t?.phone || !oldest || loadingOlder) return
    setLoadingOlder(true)
    try {
      const r = await fetch(
        `/api/admin/inbox/unified/messages?phone=${encodeURIComponent(t.phone)}&before=${encodeURIComponent(oldest)}`,
        { cache: 'no-store' })
      if (!r.ok) return
      const j = await r.json()
      const older: CommItem[] = j.messages || []
      setHasMore(!!j.pagination?.hasMore)
      // Prepending must NOT move the viewport: keep the scroll pinned to the
      // message the operator was looking at.
      const box = scrollBox.current
      const prevHeight = box?.scrollHeight ?? 0
      setMessages((prev) => [...older, ...prev])
      requestAnimationFrame(() => {
        if (box) box.scrollTop += box.scrollHeight - prevHeight
      })
    } finally {
      setLoadingOlder(false)
    }
  }, [messages, loadingOlder])

  useEffect(() => { loadThreads() }, [loadThreads])

  // ?contact=<phone> opens that conversation directly. Vendor360 and global search
  // link straight into a thread; without this they landed on a list and left the
  // operator to find the person again, which is a downgrade on what the old
  // inbox did.
  const wanted = (searchParams.get('contact') || '').trim().toLowerCase()
  useEffect(() => {
    if (!wanted || activeId || !threads.length) return
    const digits = wanted.replace(/\D/g, '').slice(-9)
    const hit = threads.find((t) =>
      (t.phone || '').toLowerCase() === wanted
      || (digits.length === 9 && (t.phone || '').replace(/\D/g, '').slice(-9) === digits))
    if (hit) open(hit)
  }, [wanted, threads, activeId])

  // Debounced message-body search. /api/admin/inbox/search was orphaned (no
  // caller anywhere) and pointed at a table with zero rows, so email bodies had
  // never been searchable at all.
  useEffect(() => {
    const needleNow = q.trim()
    if (needleNow.length < 2) { setBodyHits(new Set()); return }
    const id = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/inbox/search?q=${encodeURIComponent(needleNow)}`, { cache: 'no-store' })
        if (!r.ok) return
        const j = await r.json()
        const keys = new Set<string>()
        for (const h of (j.hits || j.results || []) as Array<{ thread_key?: string }>) {
          const k = (h.thread_key || '').toLowerCase().replace(/\D/g, '')
          if (h.thread_key) keys.add(h.thread_key.toLowerCase())
          if (k.length >= 9) keys.add(k.slice(-9))
        }
        setBodyHits(keys)
      } catch { /* search is an enhancement, never a blocker */ }
    }, 300)
    return () => clearTimeout(id)
  }, [q])

  // Realtime, same broadcast channel the webhook and mail fetchers already ping.
  useEffect(() => {
    const supabase = createClient()
    const ch = supabase
      .channel('inbox-updates')
      .on('broadcast', { event: 'refresh' }, () => {
        loadThreads(true)
        const t = threadsRef.current.find((x) => x.id === activeIdRef.current)
        if (t) loadMessages(t, { silent: true })
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [loadThreads, loadMessages])

  // Safety net if the socket drops.
  useEffect(() => {
    const id = setInterval(() => loadThreads(true), 30000)
    return () => clearInterval(id)
  }, [loadThreads])

  useEffect(() => {
    if (stickToBottom.current) streamEnd.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  function open(t: ChannelThread) {
    setActiveId(t.id)
    setMessages([])
    setMsgError(null)
    setHasMore(false)
    stickToBottom.current = true
    loadMessages(t)
  }

  const needle = q.trim().toLowerCase()
  const shown = needle
    ? threads.filter((t) => {
        const local = [t.business_name, t.peer_name, t.phone, t.last_preview]
          .some((f) => (f || '').toLowerCase().includes(needle))
        if (local) return true
        const phoneKey = (t.phone || '').replace(/\D/g, '').slice(-9)
        return (!!t.email && bodyHits.has(t.email.toLowerCase())) || (!!phoneKey && bodyHits.has(phoneKey))
      })
    : threads
  const shownFiltered = shown.filter((t) =>
    filter === 'waiting' ? t.needs_response : filter === 'unread' ? t.unread : true)
  const pinnedCount = threads.filter((t) => t.needs_response).length
  const unreadCount = threads.filter((t) => t.unread).length

  return (
    <AdminPage
      fill
      caption="COMMUNICATIONS"
      title="WhatsApp"
      subtitle={
        error ? 'Could not load these conversations.'
        : loading ? 'Loading conversations…'
        : pinnedCount > 0 ? `${pinnedCount} waiting on a person, pinned to the top.`
        : 'Nobody is waiting on a person.'
      }
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
                  {label} <span className={filter === k ? 'opacity-70' : 'text-neutral-400'}>{n}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {error && (
              <div className="m-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5">
                <p className="text-xs font-medium text-rose-800">{error}</p>
                <button onClick={() => loadThreads()} className="mt-1.5 text-xs font-semibold text-rose-700 underline underline-offset-2">
                  Try again
                </button>
              </div>
            )}
            {loading && <p className="p-4 text-sm text-neutral-500">Loading…</p>}
            {!loading && shownFiltered.length === 0 && (
              <p className="p-4 text-sm text-neutral-500">
                {needle ? `Nothing matches "${q.trim()}".`
                  : filter === 'waiting' ? 'Nothing is waiting on a person. Everything here has been answered.'
                  : filter === 'unread' ? 'Nothing unread.'
                  : 'No WhatsApp conversations.'}
              </p>
            )}
            {shownFiltered.map((t, i) => {
              // The pin IS the queue. A divider marks where waiting ends, so the
              // boundary is visible without a separate page to visit.
              const prev = shownFiltered[i - 1]
              const startsWaiting = t.needs_response && i === 0
              const startsAnswered = !t.needs_response && (i === 0 || prev.needs_response)
              return (
                <div key={t.id}>
                  {startsWaiting && (
                    <div className="sticky top-0 z-10 px-3 py-1.5 bg-rose-50/95 backdrop-blur border-y border-rose-100 text-[11px] font-semibold uppercase tracking-wide text-rose-700">
                      Waiting on a person · {pinnedCount}
                    </div>
                  )}
                  {startsAnswered && (
                    <div className="sticky top-0 z-10 px-3 py-1.5 bg-neutral-50/95 backdrop-blur border-y border-neutral-100 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                      Answered · {threads.length - pinnedCount}
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
                <div className="ml-auto shrink-0 flex items-center gap-2">
                  {active.bot_paused && (
                    <span className="text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                      Bot paused
                    </span>
                  )}
                  {active.needs_response && (
                    <span className="text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5">
                      Waiting on a person
                    </span>
                  )}
                  <ThreadToolbar
                    thread={active}
                    onChanged={() => loadThreads(true)}
                    onError={(m) => setError(m)}
                    onTogglePanel={active.application_id ? () => setPanelOpen((o) => !o) : undefined}
                    panelOpen={panelOpen}
                  />
                </div>
              </header>

              <div
                ref={scrollBox}
                onScroll={(e) => {
                  const el = e.currentTarget
                  stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
                }}
                className="flex-1 overflow-y-auto px-4 wa-wallpaper"
              >
                {hasMore && (
                  <div className="flex justify-center py-3">
                    <button
                      onClick={loadOlder}
                      disabled={loadingOlder}
                      className="px-3 py-1.5 text-xs font-medium rounded-full bg-white/80 border border-black/5 text-neutral-600 hover:bg-white disabled:opacity-50"
                    >
                      {loadingOlder ? 'Loading…' : 'Load older messages'}
                    </button>
                  </div>
                )}

                {/* Three states, not one. An error must never look like an
                    empty conversation. */}
                {msgLoading && messages.length === 0 && (
                  <p className="py-10 text-center text-sm text-neutral-500 flex items-center justify-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading conversation…
                  </p>
                )}
                {!msgLoading && msgError && (
                  <div className="my-6 mx-auto max-w-sm rounded-lg bg-white/90 border border-rose-200 px-4 py-3 text-center">
                    <p className="text-sm font-medium text-rose-700">{msgError}</p>
                    <button
                      onClick={() => active && loadMessages(active)}
                      className="mt-2 text-xs font-medium text-neutral-600 underline underline-offset-2"
                    >
                      Try again
                    </button>
                  </div>
                )}
                {!msgLoading && !msgError && messages.length === 0 && (
                  <p className="py-10 text-center text-sm text-neutral-500">
                    No messages in this conversation yet.
                  </p>
                )}

                <WhatsAppStream messages={messages} />
                <div ref={streamEnd} />
              </div>

              <footer className="p-3 border-t border-neutral-200">
                {error && <p className="mb-2 text-xs text-rose-600">{error}</p>}
                <Composer
                  channel="whatsapp"
                  phone={active.phone}
                  applicationId={active.application_id}
                  onSent={() => { if (active) loadMessages(active); loadThreads(true) }}
                  onError={(m) => setError(m)}
                />
              </footer>
            </>
          )}
        </section>

        {panelOpen && active?.application_id && (
          <VendorPanel applicationId={active.application_id} onClose={() => setPanelOpen(false)} />
        )}
      </div>
    </AdminPage>
  )
}
