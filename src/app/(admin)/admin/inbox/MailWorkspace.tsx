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
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { AdminPage } from '@/components/admin/AdminPage'
import { EmailThread } from '@/components/admin/inbox/EmailThread'
import { createClient } from '@/lib/supabase/client'
import { fmtSAST, initials } from '@/lib/inbox/format'
import type { CommItem } from '@/lib/inbox/types'
import type { ChannelThread, MailBox } from '@/lib/inbox/channel-threads'
import { Search, Pin } from 'lucide-react'
import { ThreadToolbar } from '@/components/admin/inbox/ThreadToolbar'
import { Composer } from '@/components/admin/inbox/Composer'
import { VendorPanel } from '@/components/admin/inbox/VendorPanel'

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
  /** Thread keys (phone / email) whose MESSAGE BODIES match the query. The list
   *  filter only ever saw names, subjects and the one-line preview, so searching
   *  for something a vendor actually said found nothing. */
  const [bodyHits, setBodyHits] = useState<Set<string>>(new Set())
  const [panelOpen, setPanelOpen] = useState(false)
  const searchParams = useSearchParams()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const threadsRef = useRef<ChannelThread[]>([])
  const activeIdRef = useRef<string | null>(null)
  const streamEnd = useRef<HTMLDivElement>(null)
  const listBox = useRef<HTMLDivElement>(null)
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

  // ?contact=<email> opens that conversation directly. Vendor360 and global search
  // link straight into a thread; without this they landed on a list and left the
  // operator to find the person again, which is a downgrade on what the old
  // inbox did.
  const wanted = (searchParams.get('contact') || '').trim().toLowerCase()
  useEffect(() => {
    if (!wanted || activeId || !threads.length) return
    const digits = wanted.replace(/\D/g, '').slice(-9)
    const hit = threads.find((t) =>
      (t.email || '').toLowerCase() === wanted
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

  // Jump the list back to the top whenever the filter or the search changes, so
  // a click always has a visible result.
  useEffect(() => { listBox.current?.scrollTo({ top: 0 }) }, [filter, q])

  function open(t: ChannelThread) {
    setActiveId(t.id)
    setMessages([])
    loadMessages(t)
  }

  const needle = q.trim().toLowerCase()
  const shown = needle
    ? threads.filter((t) => {
        const local = [t.business_name, t.peer_name, t.email, t.subject, t.last_preview]
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
  // Counts for the GROUP HEADERS describe the rows actually rendered. Using the
  // global totals meant filtering to Unread showed 50 rows beneath a header that
  // said 65 were waiting, which is worse than no header at all.
  const shownWaiting = shownFiltered.filter((t) => t.needs_response).length
  const shownAnswered = shownFiltered.length - shownWaiting

  return (
    <AdminPage
      fill
      bare
      caption="COMMUNICATIONS"
      title={title}
      subtitle={
        error ? 'Could not load these conversations.'
        : loading ? 'Loading conversations…'
        : pinnedCount > 0 ? `${pinnedCount} waiting on a reply, pinned to the top.`
        : subtitle
      }
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
                  {label} <span className={filter === k ? 'opacity-70' : 'text-neutral-400'}>{n}</span>
                </button>
              ))}
            </div>
          </div>

          <div ref={listBox} className="flex-1 overflow-y-auto">
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
                  : filter === 'waiting' ? 'Nothing is waiting on a reply. Everything here has been answered.'
                  : filter === 'unread' ? 'Nothing unread.'
                  : 'Nothing here.'}
              </p>
            )}
            {shownFiltered.map((t, i) => {
              const prev = shownFiltered[i - 1]
              const startsWaiting = t.needs_response && i === 0
              const startsAnswered = !t.needs_response && (i === 0 || prev.needs_response)
              return (
                <div key={t.id}>
                  {startsWaiting && (
                    <div className="px-3 py-1.5 bg-rose-50 border-y border-rose-100 text-[11px] font-semibold uppercase tracking-wide text-rose-700">
                      Waiting on a reply · {shownWaiting}
                    </div>
                  )}
                  {startsAnswered && (
                    <div className="px-3 py-1.5 bg-neutral-50 border-y border-neutral-100 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                      Answered · {shownAnswered}
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
                    {/* Same as WhatsApp: the vendor's name opens their record,
                        because "what's their status?" is the usual next thought
                        while reading a thread. */}
                    <p className="truncate text-xs text-neutral-500">
                      {active.application_id && (active.business_name || active.peer_name) ? (
                        <Link
                          href={`/admin/vendors/${active.application_id}`}
                          className="font-medium text-neutral-700 hover:text-[#cd2653] hover:underline underline-offset-2"
                          title="Open this vendor's profile"
                        >
                          {active.business_name || active.peer_name}
                        </Link>
                      ) : (active.business_name || active.peer_name || '')}
                      {active.business_name || active.peer_name ? ' · ' : ''}{active.email}
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
                    onTogglePanel={active.application_id ? () => setPanelOpen((o) => !o) : undefined}
                    panelOpen={panelOpen}
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
                <Composer
                  channel="email"
                  email={active.email}
                  applicationId={active.application_id}
                  sendingAs={sendingAs}
                  subject={active.subject}
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
