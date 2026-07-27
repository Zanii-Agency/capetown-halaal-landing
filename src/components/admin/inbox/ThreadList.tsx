'use client'

/**
 * The conversation list, shared by the WhatsApp and the mail workspaces.
 *
 * WHY IT IS ONE COMPONENT NOW. Both workspaces carried a byte-for-byte copy of
 * this list, so every list fix had to be made twice and in practice was made
 * once. Only the cosmetics ever differed (avatar colour, which fields are
 * searched, whether a subject line shows), so those are props and the behaviour
 * is not.
 *
 * THE CAP IS THE POINT. Threads waiting on a human are pinned to the top
 * (`sortPinned`, channel-threads.ts:442), which quietly made "Waiting" a strict
 * PREFIX of "All": with 31 of 50 pinned, the first 31 rows of All WERE the
 * Waiting tab, in the same order. Clicking between the two changed nothing on
 * screen, so the filters read as broken. Taona, 2026-07-28: "its like they dont
 * work". They worked. They had nothing visible to show.
 *
 * In "All" the waiting run is therefore capped: a few pins, then one row that
 * carries the rest and jumps to the Waiting tab. The pinned-to-top promise is
 * kept, the rest of the mailbox becomes reachable without scrolling past every
 * pin, and each tab now renders something the others do not.
 *
 * The dividers are keyed off the GROUPS, not off a row index. The old
 * `needs_response && i === 0` test put the header on whichever row happened to
 * land first, so it vanished entirely the moment a filter reordered the list.
 */

import type { ReactNode } from 'react'
import { useRef, useEffect } from 'react'
import { Search, Pin } from 'lucide-react'
import { fmtSAST, initials } from '@/lib/inbox/format'
import type { ChannelThread } from '@/lib/inbox/channel-threads'
import { groupThreads, type ThreadFilter } from '@/lib/inbox/thread-groups'

export type { ThreadFilter }

interface Props {
  threads: ChannelThread[]
  activeId: string | null
  onOpen: (t: ChannelThread) => void
  q: string
  onQ: (v: string) => void
  filter: ThreadFilter
  onFilter: (f: ThreadFilter) => void
  /** Thread keys whose message BODIES matched the query. */
  bodyHits: Set<string>
  loading: boolean
  error: string | null
  onRetry: () => void

  /** Channel dressing. */
  title: string
  /** Full literal classes: Tailwind cannot see interpolated names. */
  avatarClass: string
  /** "a reply" for mail, "a person" for WhatsApp. */
  waitingWord: string
  emptyAll: string
  /** Which fields the local (non-body) search looks at. */
  searchFields: (t: ChannelThread) => Array<string | null | undefined>
  /** The bold name on the row. */
  nameOf: (t: ChannelThread) => string
  /** The one or two lines under the name. */
  lines: (t: ChannelThread) => ReactNode
}

export function ThreadList({
  threads, activeId, onOpen, q, onQ, filter, onFilter, bodyHits,
  loading, error, onRetry,
  title, avatarClass, waitingWord, emptyAll, searchFields, nameOf, lines,
}: Props) {
  const listBox = useRef<HTMLDivElement>(null)

  // Jump back to the top whenever the filter or the search changes, so a click
  // always has a visible result.
  useEffect(() => { listBox.current?.scrollTo({ top: 0 }) }, [filter, q])

  const needle = q.trim().toLowerCase()
  const shown = needle
    ? threads.filter((t) => {
        if (searchFields(t).some((f) => (f || '').toLowerCase().includes(needle))) return true
        const phoneKey = (t.phone || '').replace(/\D/g, '').slice(-9)
        return (!!t.email && bodyHits.has(t.email.toLowerCase()))
          || (!!phoneKey && bodyHits.has(phoneKey))
      })
    : threads

  const { waitingRows, hiddenWaiting, waitingTotal, answered, total } =
    groupThreads(shown, filter)

  const pinnedCount = threads.filter((t) => t.needs_response).length
  const unreadCount = threads.filter((t) => t.unread).length

  const row = (t: ChannelThread) => (
    <button
      key={t.id}
      onClick={() => onOpen(t)}
      className={`w-full text-left px-3 py-2.5 flex gap-3 border-b border-neutral-100 transition-colors ${
        t.id === activeId ? 'bg-neutral-100' : 'hover:bg-neutral-50'
      }`}
    >
      <div className={`h-9 w-9 shrink-0 rounded-full grid place-items-center text-xs font-semibold ${avatarClass}`}>
        {initials(nameOf(t) || '?')}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {t.needs_response && (
            <Pin className="h-3 w-3 shrink-0 text-rose-600" aria-label={`Waiting on ${waitingWord}`} />
          )}
          <span className="truncate text-sm font-medium text-neutral-900">{nameOf(t)}</span>
          <span className="ml-auto shrink-0 text-[11px] text-neutral-400">
            {t.last_message_at ? fmtSAST(t.last_message_at) : ''}
          </span>
        </div>
        {lines(t)}
      </div>
    </button>
  )

  return (
    <>
      <div className="p-2 border-b border-neutral-200">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
          <input
            value={q}
            onChange={(e) => onQ(e.target.value)}
            placeholder={`Search ${title}`}
            className="w-full pl-8 pr-3 py-2 text-sm rounded-lg bg-neutral-100 focus:bg-white focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
          />
        </div>
        <div className="mt-2 flex items-center gap-1">
          {([
            ['all', 'All', threads.length],
            ['waiting', 'Waiting', pinnedCount],
            ['unread', 'Unread', unreadCount],
            ['starred', 'Starred', threads.filter((t) => t.starred).length],
            // Vendors includes UNAPPROVED applicants, so People is the genuine
            // remainder: suppliers, press, councils, spam.
            ['vendors', 'Vendors', threads.filter((t) => t.is_vendor).length],
            ['people', 'People', threads.filter((t) => !t.is_vendor).length],
          ] as const).map(([k, label, n]) => (
            <button
              key={k}
              onClick={() => onFilter(k)}
              aria-pressed={filter === k}
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
            <button onClick={onRetry} className="mt-1.5 text-xs font-semibold text-rose-700 underline underline-offset-2">
              Try again
            </button>
          </div>
        )}
        {loading && <p className="p-4 text-sm text-neutral-500">Loading…</p>}

        {!loading && total === 0 && (
          <p className="p-4 text-sm text-neutral-500">
            {needle ? `Nothing matches "${q.trim()}".`
              : filter === 'waiting' ? `Nothing is waiting on ${waitingWord}. Everything here has been answered.`
              : filter === 'unread' ? 'Nothing unread.'
              : emptyAll}
          </p>
        )}

        {waitingRows.length > 0 && (
          <div className="px-3 py-1.5 bg-rose-50 border-y border-rose-100 text-[11px] font-semibold uppercase tracking-wide text-rose-700">
            Waiting on {waitingWord} · {waitingTotal}
          </div>
        )}
        {waitingRows.map(row)}

        {hiddenWaiting > 0 && (
          <button
            onClick={() => onFilter('waiting')}
            className="w-full px-3 py-2 text-left text-xs font-semibold text-rose-700 bg-rose-50/60 border-b border-rose-100 hover:bg-rose-50"
          >
            {hiddenWaiting} more waiting on {waitingWord} →
          </button>
        )}

        {answered.length > 0 && (
          <div className="px-3 py-1.5 bg-neutral-50 border-y border-neutral-100 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Answered · {answered.length}
          </div>
        )}
        {answered.map(row)}
      </div>
    </>
  )
}
