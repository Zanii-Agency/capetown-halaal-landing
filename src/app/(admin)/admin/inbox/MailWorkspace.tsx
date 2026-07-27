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
import type { CommItem } from '@/lib/inbox/types'
import type { ChannelThread, MailBox } from '@/lib/inbox/channel-threads'
import { ThreadList, type ThreadFilter } from '@/components/admin/inbox/ThreadList'
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
  const [filter, setFilter] = useState<ThreadFilter>('all')
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
    loadMessages(t)
  }

  const pinnedCount = threads.filter((t) => t.needs_response).length

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
            title={title}
            avatarClass="bg-sky-100 text-sky-800"
            waitingWord="a reply"
            emptyAll="Nothing here."
            searchFields={(t) => [t.business_name, t.peer_name, t.email, t.subject, t.last_preview]}
            nameOf={(t) => t.business_name || t.peer_name || t.email || ''}
            lines={(t) => (
              <>
                {/* Subject, then snippet: the two lines Gmail shows, in that order. */}
                <p className={`truncate text-xs ${t.unread ? 'text-neutral-900 font-medium' : 'text-neutral-700'}`}>
                  {t.subject || '(no subject)'}
                </p>
                <p className="truncate text-xs text-neutral-500">
                  {t.last_direction === 'out' ? 'You: ' : ''}{t.last_preview || ''}
                </p>
              </>
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
