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
import Link from 'next/link'
import { AdminPage } from '@/components/admin/AdminPage'
import { WhatsAppStream } from '@/components/admin/inbox/WhatsAppStream'
import { createClient } from '@/lib/supabase/client'
import { initials } from '@/lib/inbox/format'
import type { CommItem } from '@/lib/inbox/types'
import type { ChannelThread } from '@/lib/inbox/channel-threads'
import { Loader2 } from 'lucide-react'
import { ThreadList, type ThreadFilter } from '@/components/admin/inbox/ThreadList'
import { ThreadToolbar } from '@/components/admin/inbox/ThreadToolbar'
import { Composer } from '@/components/admin/inbox/Composer'
import { VendorPanel } from '@/components/admin/inbox/VendorPanel'

export function WhatsAppWorkspace() {
  const [threads, setThreads] = useState<ChannelThread[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CommItem[]>([])
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<ThreadFilter>('all')
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
    // OPENING IT COUNTS AS READING IT. open() used to write nothing at all, so a
    // conversation looked identical after you had read it, forever. Optimistic
    // so the badge clears the instant you click, then persisted (wa_read_state
    // for WhatsApp, unread_count for mail) so it survives a reload.
    if (t.unread) {
      setThreads((prev) => prev.map((x) => (x.id === t.id ? { ...x, unread: false } : x)))
      fetch('/api/admin/inbox/unified/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'read',
          ...(t.application_id ? { applicationId: t.application_id } : {}),
          ...(t.email ? { email: t.email } : {}),
          ...(t.phone ? { phone: t.phone } : {}),
        }),
      }).catch(() => { /* the optimistic clear stands; the next poll corrects it */ })
    }
    setMessages([])
    setMsgError(null)
    setHasMore(false)
    stickToBottom.current = true
    loadMessages(t)
  }

  const pinnedCount = threads.filter((t) => t.needs_response).length

  return (
    <AdminPage
      fill
      bare
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
          <ThreadList
            threads={threads}
            activeId={activeId}
            onOpen={open}
            q={q}
            onQ={setQ}
            filter={filter}
            onFilter={setFilter}
            bodyHits={bodyHits}
            loading={loading}
            error={error}
            onRetry={() => loadThreads()}
            title="WhatsApp"
            avatarClass="bg-emerald-100 text-emerald-800"
            waitingWord="a person"
            emptyAll="No WhatsApp conversations."
            searchFields={(t) => [t.business_name, t.peer_name, t.phone, t.last_preview]}
            nameOf={(t) => t.business_name || t.peer_name || t.phone || ''}
            lines={(t) => (
              <p className={`truncate text-xs ${t.unread ? 'text-neutral-900 font-medium' : 'text-neutral-500'}`}>
                {t.last_direction === 'out' ? 'You: ' : ''}{t.last_preview || 'No messages'}
              </p>
            )}
          />
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
                  {/* The name is the way into the vendor's record. Reading a
                      conversation and needing their status, stall or documents
                      is the single most common next step, and it meant leaving
                      for the vendors list and searching for them by hand. */}
                  {active.application_id ? (
                    <Link
                      href={`/admin/vendors/${active.application_id}`}
                      className="block truncate text-sm font-semibold text-neutral-900 hover:text-[#cd2653] hover:underline underline-offset-2"
                      title="Open this vendor's profile"
                    >
                      {active.business_name || active.peer_name || active.phone}
                    </Link>
                  ) : (
                    <p className="truncate text-sm font-semibold text-neutral-900">
                      {active.business_name || active.peer_name || active.phone}
                    </p>
                  )}
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
