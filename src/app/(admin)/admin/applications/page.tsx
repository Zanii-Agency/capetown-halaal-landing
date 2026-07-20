'use client'

// Triage workbench: two-pane layout (queue + preview), full keyboard layer,
// bulk actions, dedupe drawer, live "X to go" counter.
//
// All side-effecting actions go through three admin endpoints introduced
// alongside this page:
//   /api/admin/applications/[id]/action  (single-row, j/k driven)
//   /api/admin/applications/bulk         (multi-row, toolbar driven)
//   /api/admin/applications/dedupe       (keeper + supersede list)
//
// The queue feed comes from /api/admin/applications (windowed + counted).

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, Layers, Search } from 'lucide-react'
import { AdminPage } from '@/components/admin/AdminPage'
import { QueueList } from '@/components/admin/applications/QueueList'
import { PreviewPane } from '@/components/admin/applications/PreviewPane'
import { ShortcutsOverlay } from '@/components/admin/applications/ShortcutsOverlay'
import { DedupeDrawer } from '@/components/admin/applications/DedupeDrawer'
import { BulkToolbar } from '@/components/admin/applications/BulkToolbar'
import ApplicationsFilters, {
  type StatusGroup,
  type ScoreBucket,
} from '@/components/admin/applications/ApplicationsFilters'
import {
  SECTOR_CYCLE,
  type WorkbenchApplication,
} from '@/components/admin/applications/types'
import { TOTAL_DEFINED_CAPACITY } from '@/lib/venue-zones'

const QUEUE_LIMIT = 200

function phoneLast9(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D+/g, '').slice(-9)
}

export default function ApplicationsWorkbenchPage() {
  // ---- queue state ----
  const [rows, setRows] = useState<WorkbenchApplication[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingTotal, setPendingTotal] = useState<number>(0)
  const [approvedTotal, setApprovedTotal] = useState<number>(0)
  const [search, setSearch] = useState('')

  // ---- filter state ----
  // 'open' is the default landing slice (pending + info_requested), matching
  // the prior behavior. Status + tier hit the server; sector + score get
  // applied client-side over the returned slice so chips work even on rows
  // that have not yet been sector-tagged via the `t` shortcut.
  const [status, setStatus] = useState<StatusGroup>('open')
  const [sector, setSector] = useState<string | null>(null)
  const [score, setScore] = useState<ScoreBucket>('all')
  const [tier, setTier] = useState<string | null>(null)

  // ---- sort + additional filters ----
  const searchParams = useSearchParams()
  const router = useRouter()
  const [sortBy, setSortBy] = useState(searchParams.get('sort') || 'oldest')
  const [paymentFilter, setPaymentFilter] = useState(searchParams.get('payment') || '')
  const [docFilter, setDocFilter] = useState(searchParams.get('doc') || '')

  // ---- triage UI state ----
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [dedupeOpen, setDedupeOpen] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  // ---- load the queue ----
  // Status group → server `status=` list. `open` = pending+info_requested
  // (the prior default landing slice). `all` omits the param entirely so the
  // server returns every status.
  const statusParam = useMemo<string | null>(() => {
    switch (status) {
      case 'open': return 'pending,info_requested'
      case 'pending': return 'pending'
      case 'info_requested': return 'info_requested'
      case 'approved': return 'approved'
      case 'rejected': return 'rejected'
      case 'all': return null
    }
  }, [status])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        order: 'oldest',
        limit: String(QUEUE_LIMIT),
      })
      if (statusParam) params.set('status', statusParam)
      if (tier) params.set('tier', tier)
      if (search.trim()) params.set('search', search.trim())
      const res = await fetch(`/api/admin/applications?${params.toString()}`)
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        console.error('queue load failed:', j)
        return
      }
      const data = await res.json()
      const list = (data.applications ?? []) as WorkbenchApplication[]
      setRows(list)
      setPendingTotal(data.pending_total ?? 0)
      setApprovedTotal(data.approved_total ?? 0)
      // Keep focus where it was if still present; otherwise pick the first row.
      setFocusedId((prev) => (prev && list.some((r) => r.id === prev) ? prev : list[0]?.id ?? null))
    } finally {
      setLoading(false)
    }
  }, [search, statusParam, tier])

  useEffect(() => {
    reload()
  }, [reload])

  // ---- client-side filter slice (sector + score) ----
  // Sector matches against product_categories[] AND the legacy single `sector`
  // column so untagged rows still surface under their category chip.
  // Score buckets: low <40, mid 40-79, high 80+. Rows with a null score are
  // treated as bucket 'low' so Samreen can find them.
  const visibleRows = useMemo<WorkbenchApplication[]>(() => {
    return rows.filter((r) => {
      if (sector) {
        const cats = r.product_categories || []
        const hit = cats.includes(sector) || r.sector === sector
        if (!hit) return false
      }
      if (score !== 'all') {
        const s = r.completeness_score ?? 0
        if (score === 'low' && !(s < 40)) return false
        if (score === 'mid' && !(s >= 40 && s < 80)) return false
        if (score === 'high' && !(s >= 80)) return false
      }
      if (paymentFilter) {
        const ps = r.payment_status
        if (paymentFilter === 'none') {
          if (ps && ps !== 'none') return false
        } else if (ps !== paymentFilter) {
          return false
        }
      }
      if (docFilter === 'complete') {
        if ((r.docCount ?? 0) < 3) return false
      } else if (docFilter === 'incomplete') {
        if ((r.docCount ?? 0) >= 3) return false
      } else if (docFilter === 'rejected') {
        if (!r.docs_rejected) return false
      }
      return true
    })
  }, [rows, sector, score, paymentFilter, docFilter])

  // ---- sort visible rows ----
  const sortedVisibleRows = useMemo<WorkbenchApplication[]>(() => {
    const sorted = [...visibleRows]
    switch (sortBy) {
      case 'newest':
        sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        break
      case 'score_asc':
        sorted.sort((a, b) => (a.completeness_score ?? 0) - (b.completeness_score ?? 0))
        break
      case 'score_desc':
        sorted.sort((a, b) => (b.completeness_score ?? 0) - (a.completeness_score ?? 0))
        break
      case 'payment_due':
        sorted.sort((a, b) => {
          const aDue = a.paid_at ? new Date(a.paid_at).getTime() : -1
          const bDue = b.paid_at ? new Date(b.paid_at).getTime() : -1
          return aDue - bDue
        })
        break
      default:
        sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    }
    return sorted
  }, [visibleRows, sortBy])

  // When the filter slice changes, snap focus to the first row of the new
  // slice so j/k traversal and a/r/i act on something visible.
  useEffect(() => {
    setFocusedId((prev) => {
      if (prev && visibleRows.some((r) => r.id === prev)) return prev
      return visibleRows[0]?.id ?? null
    })
  }, [visibleRows])

  // ---- sync filter state to URL ----
  useEffect(() => {
    const params = new URLSearchParams()
    params.set('sort', sortBy)
    if (paymentFilter) params.set('payment', paymentFilter)
    if (docFilter) params.set('doc', docFilter)
    const qs = params.toString()
    const current = window.location.search.replace(/^\?/, '')
    if (qs !== current) {
      router.replace(`?${qs}`, { scroll: false })
    }
  }, [sortBy, paymentFilter, docFilter, router])

  // ---- derived: focused row + phone-cluster siblings ----
  // Focused row lookup uses the full rows array so a row that drops out of
  // the visible slice mid-action (e.g. status flip from pending to approved)
  // still resolves until the next slice tick.
  const focused = useMemo<WorkbenchApplication | null>(
    () => rows.find((r) => r.id === focusedId) ?? null,
    [rows, focusedId]
  )

  // Duplicate siblings span the WHOLE loaded set, not the visible slice, so
  // filtering by sector or score never hides a phone-cluster match.
  const duplicateSiblings = useMemo<WorkbenchApplication[]>(() => {
    if (!focused) return []
    const key = phoneLast9(focused.phone)
    if (!key) return []
    return rows.filter((r) => r.id !== focused.id && phoneLast9(r.phone) === key)
  }, [rows, focused])

  // ---- optimistic update + revert helpers ----
  const flashHint = useCallback((msg: string) => {
    setHint(msg)
    window.setTimeout(() => setHint(null), 1500)
  }, [])

  const applyOptimistic = useCallback(
    (id: string, patch: Partial<WorkbenchApplication>) => {
      let prev: WorkbenchApplication | null = null
      setRows((rs) => {
        const idx = rs.findIndex((r) => r.id === id)
        if (idx < 0) return rs
        prev = rs[idx]
        const next = [...rs]
        next[idx] = { ...prev, ...patch }
        return next
      })
      return () => {
        if (!prev) return
        setRows((rs) => rs.map((r) => (r.id === id ? (prev as WorkbenchApplication) : r)))
      }
    },
    []
  )

  // ---- single-row action -----------------------------------------------------
  const runAction = useCallback(
    async (
      id: string,
      action: 'approve' | 'reject' | 'request_info' | 'tag' | 'snooze',
      payload?: { reason?: string; sector?: string; snooze_hours?: number }
    ) => {
      // Optimistic patch
      let patch: Partial<WorkbenchApplication> = {}
      if (action === 'approve') patch = { status: 'approved', approved_at: new Date().toISOString() }
      if (action === 'reject') patch = { status: 'rejected' }
      if (action === 'request_info') patch = { status: 'info_requested' }
      if (action === 'tag' && payload?.sector) patch = { sector: payload.sector }
      const revert = applyOptimistic(id, patch)

      // Decrement counter on terminal moves out of the pending pool.
      const decrement = action === 'approve' || action === 'reject'
      if (decrement) setPendingTotal((n) => Math.max(0, n - 1))

      setBusy(true)
      try {
        const res = await fetch(`/api/admin/applications/${id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...(payload ?? {}) }),
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          revert()
          if (decrement) setPendingTotal((n) => n + 1)
          window.alert(j?.error || 'Action failed.')
          return false
        }
        flashHint(action === 'tag' ? `tagged ${payload?.sector}` : action.replace('_', ' '))
        return true
      } catch (err) {
        revert()
        if (decrement) setPendingTotal((n) => n + 1)
        console.error(err)
        window.alert('Action failed.')
        return false
      } finally {
        setBusy(false)
      }
    },
    [applyOptimistic, flashHint]
  )

  // ---- bulk action -----------------------------------------------------------
  const runBulk = useCallback(
    async (
      action: 'approve' | 'reject' | 'request_info' | 'tag',
      payload?: { reason?: string; sector?: string }
    ) => {
      const ids = [...selectedIds]
      if (ids.length === 0) return
      setBusy(true)
      try {
        const res = await fetch('/api/admin/applications/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, action, ...(payload ?? {}) }),
        })
        const j = await res.json().catch(() => ({}))
        if (!res.ok) {
          window.alert(j?.error || 'Bulk action failed.')
          return
        }
        flashHint(`${action.replace('_', ' ')} ×${j.ok ?? ids.length}`)
        setSelectedIds(new Set())
        await reload()
      } finally {
        setBusy(false)
      }
    },
    [selectedIds, reload, flashHint]
  )

  // ---- keyboard layer --------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // When an overlay or drawer is open, swallow every key except Escape.
      // Samreen reads the cheatsheet with the queue still mounted; without
      // this guard, `a`/`r`/`i`/`t`/`j`/`k` silently fire against the focused
      // row behind the overlay and approve/reject the wrong vendor.
      if ((shortcutsOpen || dedupeOpen) && e.key !== 'Escape') return

      // Don't hijack the user's typing into inputs / textareas.
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Modals close on Escape.
      if (e.key === 'Escape') {
        if (shortcutsOpen) setShortcutsOpen(false)
        if (dedupeOpen) setDedupeOpen(false)
        return
      }

      if (e.key === '?') {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
        return
      }

      if (visibleRows.length === 0) return
      const idx = focusedId ? visibleRows.findIndex((r) => r.id === focusedId) : -1

      if (e.key === 'j') {
        e.preventDefault()
        const next = visibleRows[Math.min(visibleRows.length - 1, Math.max(0, idx + 1))]
        if (next) setFocusedId(next.id)
        return
      }
      if (e.key === 'k') {
        e.preventDefault()
        const prev = visibleRows[Math.max(0, idx - 1)]
        if (prev) setFocusedId(prev.id)
        return
      }
      if (e.key === 'x') {
        e.preventDefault()
        if (!focusedId) return
        setSelectedIds((s) => {
          const next = new Set(s)
          if (next.has(focusedId)) next.delete(focusedId)
          else next.add(focusedId)
          return next
        })
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (focusedId) window.open(`/admin/applications/${focusedId}`, '_self')
        return
      }
      if (e.key === 'm') {
        e.preventDefault()
        setDedupeOpen(true)
        return
      }
      if (!focusedId) return

      if (e.key === 'a') {
        e.preventDefault()
        runAction(focusedId, 'approve')
        return
      }
      if (e.key === 'r') {
        e.preventDefault()
        const reason = window.prompt('Reason for reject?') ?? ''
        if (!reason.trim()) {
          flashHint('reject cancelled')
          return
        }
        runAction(focusedId, 'reject', { reason })
        return
      }
      if (e.key === 'i') {
        e.preventDefault()
        // Picker is the bulk-toolbar dropdown when selection exists; for the
        // single-row case we use a quick prompt of template labels.
        const reason = window.prompt(
          'Info-request reason (free text, or leave blank for the default "Outstanding documents" template):',
          'We still need your halaal certificate and trading licence to finalise review.'
        )
        if (reason === null) return
        runAction(focusedId, 'request_info', { reason })
        return
      }
      if (e.key === 't') {
        e.preventDefault()
        const current = focused?.sector ?? ''
        const i = SECTOR_CYCLE.indexOf(current)
        const next = SECTOR_CYCLE[(i + 1) % SECTOR_CYCLE.length]
        runAction(focusedId, 'tag', { sector: next })
        return
      }
      if (e.key === 's') {
        e.preventDefault()
        runAction(focusedId, 'snooze')
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visibleRows, focusedId, focused, runAction, shortcutsOpen, dedupeOpen, flashHint])

  // ---- render ---------------------------------------------------------------
  const selectedCount = selectedIds.size

  return (
    <AdminPage title="Applications" caption="OPERATIONS">
    <div className="flex flex-col h-dvh overflow-hidden bg-neutral-50">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-5 py-2.5 border-b border-neutral-200 bg-white">
        <div className="flex items-baseline gap-2">
          {/* Capacity view: the festival has TOTAL_DEFINED_CAPACITY (308) spaces
              total (243 marquee + 20 bedouin + 30 food/drink + 10 dessert + 5
              snack). The number that matters is how many are filled vs free. */}
          <span className="text-lg font-semibold tabular-nums text-emerald-700">
            {Math.max(0, TOTAL_DEFINED_CAPACITY - approvedTotal)}
          </span>
          <span className="text-sm text-neutral-500">
            of {TOTAL_DEFINED_CAPACITY} spaces left
          </span>
          <span className="text-xs text-neutral-400 ml-1 tabular-nums">
            ({approvedTotal} approved · {pendingTotal} pending)
          </span>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)}
            className="text-xs border border-neutral-200 rounded-lg px-2 py-1 bg-white ml-2">
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
            <option value="score_asc">Score ascending</option>
            <option value="score_desc">Score descending</option>
            <option value="payment_due">Payment due soon</option>
          </select>
        </div>
        <span className="w-px h-5 bg-neutral-200" />
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search business, contact, email, phone"
            className="w-full pl-8 pr-2 py-1.5 text-sm border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#cd2653]"
          />
        </div>
        <button
          onClick={() => setDedupeOpen(true)}
          className="ml-auto px-2.5 py-1.5 text-xs rounded-md border border-neutral-200 hover:border-neutral-400 inline-flex items-center gap-1.5 text-neutral-700"
        >
          <Layers className="w-3.5 h-3.5" /> Dedupe
        </button>
        <Link
          href="/admin"
          className="text-xs text-neutral-500 hover:text-neutral-900"
        >
          back to dashboard
        </Link>
      </header>

      {/* Filter chips (status / sector / score / tier) */}
      <div className="px-5 py-3 bg-neutral-50 border-b border-neutral-200 space-y-2">
        <ApplicationsFilters
          rows={rows}
          status={status}
          setStatus={setStatus}
          sector={sector}
          setSector={setSector}
          score={score}
          setScore={setScore}
          tier={tier}
          setTier={setTier}
        />
        <div className="flex items-center gap-2">
          <select value={paymentFilter} onChange={e => setPaymentFilter(e.target.value)}
            className="text-xs border border-neutral-200 rounded-lg px-2 py-1 bg-white">
            <option value="">Payment</option>
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
            <option value="none">Not invoiced</option>
          </select>
          <select value={docFilter} onChange={e => setDocFilter(e.target.value)}
            className="text-xs border border-neutral-200 rounded-lg px-2 py-1 bg-white">
            <option value="">Documents</option>
            <option value="complete">All complete</option>
            <option value="incomplete">Incomplete</option>
            <option value="rejected">Has rejected</option>
          </select>
        </div>
      </div>

      {/* Two-pane body */}
      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(320px,420px)_1fr]">
        <div className="border-r border-neutral-200 bg-white flex flex-col min-h-0">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-neutral-400" />
            </div>
          ) : (
            <div className="overflow-y-auto flex-1 min-h-0">
              <QueueList
                rows={sortedVisibleRows}
                focusedId={focusedId}
                selectedIds={selectedIds}
                onFocus={setFocusedId}
                onOpen={(id) => window.open(`/admin/applications/${id}`, '_self')}
                // Mobile-only row actions. Same intents as the desktop keyboard
                // shortcuts; reuses the single-row action endpoint via runAction.
                onAction={(id, action) => {
                  if (action.kind === 'approve') runAction(id, 'approve')
                  else if (action.kind === 'reject') runAction(id, 'reject', { reason: action.reason })
                  else if (action.kind === 'request_info') runAction(id, 'request_info', { reason: action.reason })
                  else if (action.kind === 'tag') runAction(id, 'tag', { sector: action.sector })
                }}
              />
            </div>
          )}
        </div>
        <div className="bg-neutral-50 overflow-y-auto flex-1 min-h-0">
          <PreviewPane
            row={focused}
            duplicateSiblings={duplicateSiblings}
            // Mouse-driven approve: same path as `a`. No confirm modal;
            // optimistic update + revert on fail is handled inside runAction.
            onApprove={(id) => runAction(id, 'approve')}
            // Reject prompts for a reason (mirrors `r`). Cancel or blank
            // = flash hint and skip the network call.
            onReject={(id) => {
              const reason = window.prompt('Reason for reject?') ?? ''
              if (!reason.trim()) {
                flashHint('reject cancelled')
                return Promise.resolve(false)
              }
              return runAction(id, 'reject', { reason })
            }}
            // Request info prompts with the default template body so the
            // operator can edit before sending (mirrors `i`).
            onRequestInfo={(id) => {
              const reason = window.prompt(
                'Info-request reason (free text, or leave blank for the default "Outstanding documents" template):',
                'We still need your halaal certificate and trading licence to finalise review.'
              )
              if (reason === null) return Promise.resolve(false)
              return runAction(id, 'request_info', { reason })
            }}
          />
        </div>
      </div>

      {/* Context-aware action bar:
          - 0 rows selected: thin keyboard-hint strip (critical keys only).
          - >=1 rows selected: BulkToolbar with explicit Approve/Reject/Tag/Cancel.
          Same row, same height — no layout jump. */}
      {selectedCount > 0 ? (
        <footer className="px-5 py-1.5 border-t border-neutral-200 bg-neutral-50 flex items-center gap-3 min-h-[32px]">
          <BulkToolbar
            count={selectedCount}
            busy={busy}
            onRun={runBulk}
            onClear={() => setSelectedIds(new Set())}
          />
          {hint && (
            <span className="ml-auto text-emerald-600 font-medium text-[11px]">{hint}</span>
          )}
        </footer>
      ) : (
        <footer className="px-5 py-1.5 border-t border-neutral-200 bg-white text-[11px] text-neutral-500 flex items-center gap-3 flex-wrap min-h-[32px]">
          <kbd className="kb">j</kbd><kbd className="kb">k</kbd><span>navigate</span>
          <span className="text-neutral-300">.</span>
          <kbd className="kb">a</kbd><span>approve focused</span>
          <span className="text-neutral-300">.</span>
          <kbd className="kb">r</kbd><span>reject focused</span>
          <span className="text-neutral-300">.</span>
          <kbd className="kb">x</kbd><span>select</span>
          <span className="text-neutral-300">.</span>
          <kbd className="kb">?</kbd><span>all shortcuts</span>
          {hint && (
            <span className="ml-auto text-emerald-600 font-medium">{hint}</span>
          )}
        </footer>
      )}

      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <DedupeDrawer
        open={dedupeOpen}
        rows={rows}
        onClose={() => setDedupeOpen(false)}
        onSubmitted={async () => {
          setDedupeOpen(false)
          await reload()
        }}
      />

      {/* Tiny inline-only style for footer kbds (Tailwind 4 supports @layer in
          global css; we keep it scoped here to avoid touching globals). */}
      <style jsx>{`
        :global(.kb) {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 18px;
          height: 18px;
          padding: 0 4px;
          border-radius: 3px;
          border: 1px solid rgb(212 212 216);
          background: rgb(250 250 250);
          color: rgb(64 64 64);
          font-family: ui-monospace, SFMono-Regular, monospace;
          font-size: 10px;
        }
      `}</style>
    </div>
    </AdminPage>
  )
}
