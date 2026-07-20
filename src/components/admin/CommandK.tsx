'use client'

/**
 * Linear-style cmd+K global search for the admin portal.
 *
 * - Toggle: cmd+K (mac) / ctrl+K (win+linux), anywhere in /admin.
 *   Guard: listener no-ops while focus is inside another component's
 *   input / textarea / contentEditable element so it does not fight
 *   the triage queue or the broadcast composer.
 * - Close: ESC, backdrop click, or pressing cmd+K again.
 * - Results: 4 groups, up to 6 each (24 max visible). Arrow up/down
 *   moves across the flat list of currently-visible rows. Enter
 *   navigates to the row's canonical link path (provided by the API).
 * - Empty query: shows RECENT (last 5 successful queries from
 *   localStorage). Loading: skeleton rows. Errors / empty: a single
 *   line of guidance.
 * - Server queries are debounced 300ms. The endpoint also caps result
 *   count, so a fast typer cannot flood the database.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Z_CLASS } from '@/lib/z'

const RECENT_KEY = 'admin.commandk.recent'
const RECENT_MAX = 5
const DEBOUNCE_MS = 300

const ADMIN_PAGES = [
  { label: 'Dashboard', to: '/admin' },
  { label: 'Applications', to: '/admin/applications' },
  { label: 'Allocation', to: '/admin/allocation' },
  { label: 'Vendors', to: '/admin/vendors' },
  { label: 'Inbox', to: '/admin/customer-inbox' },
  { label: 'Support Inbox', to: '/admin/support-inbox' },
  { label: 'Broadcast', to: '/admin/broadcast' },
  { label: 'Tickets', to: '/admin/tickets' },
  { label: 'Analytics', to: '/admin/analytics' },
  { label: 'Activity Feed', to: '/admin/settings/activity' },
  { label: 'Comms Health', to: '/admin/settings/comms-health' },
]

interface VendorHit {
  id: string
  business_name: string | null
  contact_name: string | null
  phone: string | null
  status: string | null
  sector: string | null
  link: string
}

interface BuyerHit {
  id: string
  name: string
  email: string | null
  phone: string | null
  total: string | null
  status: string | null
  link: string
}

interface WaThreadHit {
  id: string
  thread_key: string
  channel: 'wa' | 'mail'
  last_inbound_at: string | null
  link: string
}

interface SupportThreadHit {
  id: string
  peer_email: string | null
  peer_name: string | null
  subject: string | null
  last_inbound_at: string | null
  link: string
}

interface SearchResponse {
  vendors: VendorHit[]
  buyers: BuyerHit[]
  wa_threads: WaThreadHit[]
  support_threads: SupportThreadHit[]
}

interface FlatRow {
  key: string
  link: string
  group: string
  primary: string
  secondary: string
  status?: string
}

function flatten(r: SearchResponse): { group: string; rows: FlatRow[] }[] {
  return [
    {
      group: 'Vendors',
      rows: r.vendors.map((v) => ({
        key: `v:${v.id}`,
        link: v.link,
        group: 'Vendors',
        primary: v.business_name || v.contact_name || 'Unnamed vendor',
        secondary: [v.contact_name, v.phone].filter(Boolean).join(' . '),
        status: v.status || undefined,
      })),
    },
    {
      group: 'Ticket buyers',
      rows: r.buyers.map((b) => ({
        key: `b:${b.id}`,
        link: b.link,
        group: 'Ticket buyers',
        primary: b.name,
        secondary: [b.email, b.phone, b.status].filter(Boolean).join(' . '),
      })),
    },
    {
      group: 'WhatsApp threads',
      rows: r.wa_threads.map((t) => ({
        key: `w:${t.id}`,
        link: t.link,
        group: 'WhatsApp threads',
        primary: t.thread_key,
        secondary: t.last_inbound_at
          ? new Date(t.last_inbound_at).toLocaleString()
          : 'no inbound yet',
      })),
    },
    {
      group: 'Support emails',
      rows: r.support_threads.map((s) => ({
        key: `s:${s.id}`,
        link: s.link,
        group: 'Support emails',
        primary: s.subject || '(no subject)',
        secondary: [s.peer_name, s.peer_email].filter(Boolean).join(' . '),
      })),
    },
  ]
}

export function CommandK() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const [recents, setRecents] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Load recents on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY)
      if (raw) setRecents(JSON.parse(raw))
    } catch {
      // Ignore localStorage failures (private mode, etc.)
    }
  }, [])

  const pushRecent = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) return
    // B9: never persist phone-shaped queries to localStorage. A "recent"
    // dropdown that resurfaces phone numbers to anyone who borrows a logged-in
    // admin laptop is a PII leak. We strip the very common patterns:
    //   - bare digit strings of length 6-15 (e.g. 27651234567)
    //   - + or 00 prefixed digit strings (e.g. +27651234567)
    //   - digits with separators (e.g. 27-65-123-4567 or 27 65 123 4567)
    // If after removing separators the query is all digits and >=6 chars, drop.
    const digitsOnly = trimmed.replace(/[\s\-+().]/g, '')
    if (/^\d{6,15}$/.test(digitsOnly)) return
    setRecents((prev) => {
      const next = [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, RECENT_MAX)
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        // Ignore.
      }
      return next
    })
  }, [])

  // Global cmd+K toggle. Linear / Vercel pattern: cmd+K ALWAYS opens,
  // regardless of focus, so the operator never has to click out of an
  // input first. The previous guard ("don't steal cmd+K while typing
  // into another input") was the root cause of the dead-shortcut bug
  // reported by the walkthrough verifier, because the sidebar search
  // box silently held focus on /admin/bot-inbox and ate the keystroke.
  // We still block cmd+K when typing INSIDE the CommandK modal itself
  // (handled by onInputKeyDown), and we keep contentEditable surfaces
  // (Slate / ProseMirror) exempt only when the modal is already open
  // so the toggle still closes the modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Match both 'k' and 'K' (caps lock, shift+cmd+k) and tolerate
      // browsers that surface e.code === 'KeyK' instead of e.key.
      const isK = e.key === 'k' || e.key === 'K' || e.code === 'KeyK'
      if (isK && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        e.stopPropagation()
        setOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  // Reset state every time the modal opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults(null)
      setActiveIdx(0)
      setLoading(false)
      // Defer focus to ensure the input has mounted.
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      abortRef.current?.abort()
    }
  }, [open])

  // Debounced fetch.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2 || q.startsWith('/')) {
      setResults(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const t = setTimeout(async () => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      try {
        const res = await fetch(`/api/admin/search?q=${encodeURIComponent(q)}`, {
          signal: ctrl.signal,
        })
        if (!res.ok) {
          setResults({ vendors: [], buyers: [], wa_threads: [], support_threads: [] })
          setLoading(false)
          return
        }
        const data = (await res.json()) as SearchResponse
        setResults(data)
        setActiveIdx(0)
        const total =
          data.vendors.length +
          data.buyers.length +
          data.wa_threads.length +
          data.support_threads.length
        if (total > 0) pushRecent(q)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.error('[CommandK] fetch error:', err)
          setResults({ vendors: [], buyers: [], wa_threads: [], support_threads: [] })
        }
      } finally {
        setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, open, pushRecent])

  const groups = useMemo(() => (results ? flatten(results) : []), [results])
  const flatRows = useMemo(() => groups.flatMap((g) => g.rows), [groups])

  // Arrow nav + Enter.
  const navigateAndClose = useCallback(
    (href: string) => {
      setOpen(false)
      router.push(href)
    },
    [router]
  )

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const total = isPageNav ? totalPageResults : flatRows.length
      if (total === 0) return
      setActiveIdx((i) => (i + 1) % total)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const total = isPageNav ? totalPageResults : flatRows.length
      if (total === 0) return
      setActiveIdx((i) => (i - 1 + total) % total)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (isPageNav) {
        const page = filteredPages[activeIdx]
        if (page) navigateAndClose(page.to)
      } else {
        const row = flatRows[activeIdx]
        if (row) navigateAndClose(row.link)
      }
    }
  }

  if (!open) return null

  const q = query.trim()
  const showRecents = q.length < 2
  const isPageNav = q.startsWith('/')
  const totalHits = flatRows.length

  const pageFilter = q.slice(1).toLowerCase()
  const filteredPages = isPageNav
    ? ADMIN_PAGES.filter((p) => p.label.toLowerCase().includes(pageFilter))
    : []
  const totalPageResults = filteredPages.length

  return (
    <div
      className={`fixed inset-0 ${Z_CLASS.commandPalette} flex items-start justify-center pt-[12vh]`}
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
    >
      <button
        type="button"
        aria-label="Close search"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      <div className="relative w-[min(640px,92vw)] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl">
        <div className="border-b border-neutral-200 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search vendors, buyers, WhatsApp, support."
            className="w-full bg-transparent text-base text-neutral-900 placeholder:text-neutral-400 focus:outline-none"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {isPageNav && (
            <PageNavBlock
              pages={filteredPages}
              activeIdx={activeIdx}
              onPick={navigateAndClose}
              onHoverIdx={(i) => setActiveIdx(i)}
            />
          )}

          {!isPageNav && showRecents && (
            <RecentsBlock
              recents={recents}
              onPick={(r) => setQuery(r)}
            />
          )}

          {!isPageNav && !showRecents && loading && <SkeletonRows />}

          {!isPageNav && !showRecents && !loading && results && totalHits === 0 && (
            <div className="px-4 py-8 text-center text-sm text-neutral-500">
              Nothing matches &quot;{q}&quot;. Try a phone number or business name.
            </div>
          )}

          {!isPageNav && !showRecents && !loading && totalHits > 0 && (
            <ResultsBlock
              groups={groups}
              activeIdx={activeIdx}
              onPick={navigateAndClose}
              onHoverIdx={(i) => setActiveIdx(i)}
            />
          )}
        </div>

        <Footer />
      </div>
    </div>
  )
}

function RecentsBlock({
  recents,
  onPick,
}: {
  recents: string[]
  onPick: (s: string) => void
}) {
  if (recents.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-neutral-500">
        Type to search.
      </div>
    )
  }
  return (
    <div className="py-2">
      <div className="px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
        Recent
      </div>
      {recents.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onPick(r)}
          className="flex w-full items-center px-4 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50"
        >
          {r}
        </button>
      ))}
    </div>
  )
}

function SkeletonRows() {
  return (
    <div className="space-y-2 px-4 py-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-9 animate-pulse rounded-md bg-neutral-100"
        />
      ))}
    </div>
  )
}

function ResultsBlock({
  groups,
  activeIdx,
  onPick,
  onHoverIdx,
}: {
  groups: { group: string; rows: FlatRow[] }[]
  activeIdx: number
  onPick: (href: string) => void
  onHoverIdx: (i: number) => void
}) {
  let cursor = 0
  return (
    <div className="py-2">
      {groups.map((g) => {
        if (g.rows.length === 0) return null
        return (
          <div key={g.group} className="py-1">
            <div className="px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              {g.group}
            </div>
            {g.rows.map((row) => {
              const idx = cursor++
              const active = idx === activeIdx
              return (
                <Link
                  key={row.key}
                  href={row.link}
                  prefetch={false}
                  onClick={(e) => {
                    e.preventDefault()
                    onPick(row.link)
                  }}
                  onMouseEnter={() => onHoverIdx(idx)}
                  className={[
                    'flex items-center justify-between gap-3 px-4 py-2 text-sm',
                    active
                      ? 'bg-neutral-900 text-white'
                      : 'text-neutral-800 hover:bg-neutral-50',
                  ].join(' ')}
                >
                  <span className="truncate flex items-center gap-2">
                    {row.primary}
                    {row.status && (
                      <span className={[
                        'inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium',
                        row.status === 'approved' ? 'bg-emerald-50 text-emerald-700' :
                        row.status === 'pending' ? 'bg-amber-50 text-amber-700' :
                        'bg-rose-50 text-rose-700',
                      ].join(' ')}>
                        {row.status}
                      </span>
                    )}
                  </span>
                  <span
                    className={[
                      'truncate text-xs',
                      active ? 'text-neutral-300' : 'text-neutral-500',
                    ].join(' ')}
                  >
                    {row.secondary}
                  </span>
                </Link>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function PageNavBlock({
  pages,
  activeIdx,
  onPick,
  onHoverIdx,
}: {
  pages: { label: string; to: string }[]
  activeIdx: number
  onPick: (href: string) => void
  onHoverIdx: (i: number) => void
}) {
  return (
    <div className="py-2">
      <div className="px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
        Admin Pages
      </div>
      {pages.length === 0 ? (
        <div className="px-4 py-4 text-center text-sm text-neutral-500">
          No matching pages
        </div>
      ) : (
        pages.map((p, idx) => {
          const active = idx === activeIdx
          return (
            <Link
              key={p.to}
              href={p.to}
              prefetch={false}
              onClick={(e) => {
                e.preventDefault()
                onPick(p.to)
              }}
              onMouseEnter={() => onHoverIdx(idx)}
              className={[
                'flex items-center justify-between gap-3 px-4 py-2 text-sm',
                active
                  ? 'bg-neutral-900 text-white'
                  : 'text-neutral-800 hover:bg-neutral-50',
              ].join(' ')}
            >
              <span className="truncate">{p.label}</span>
            </Link>
          )
        })
      )}
    </div>
  )
}

function Footer() {
  return (
    <div className="flex items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-2 text-[11px] text-neutral-500">
      <span>
        <kbd className="rounded border border-neutral-300 bg-white px-1">↑</kbd>{' '}
        <kbd className="rounded border border-neutral-300 bg-white px-1">↓</kbd>{' '}
        navigate
      </span>
      <span>
        <kbd className="rounded border border-neutral-300 bg-white px-1">enter</kbd>{' '}
        open
      </span>
      <span>
        <kbd className="rounded border border-neutral-300 bg-white px-1">esc</kbd>{' '}
        close
      </span>
    </div>
  )
}
