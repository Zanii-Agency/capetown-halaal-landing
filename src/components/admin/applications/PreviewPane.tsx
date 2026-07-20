'use client'

// Right-rail preview pane. Shows the full application context for the
// currently focused row without navigating. j/k swaps the focused row,
// this pane re-renders against the new id.
//
// Pulls AI suggestions from Agent 2's endpoint:
//   GET /api/admin/applications/suggest?id=<uuid>
//     -> { sector_suggestions, completeness_score, dupe_of }
// Failure: render without suggestions, never block the row.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import {
  Mail,
  Phone,
  Building2,
  Tag,
  AlertTriangle,
  ExternalLink,
  CheckCircle2,
  HelpCircle,
  XCircle,
  Loader2,
  RotateCcw,
  Plus,
  X,
  Zap,
} from 'lucide-react'
import { computeVendorPricing, formatRand } from '@/lib/payments/pricing'
import type {
  WorkbenchApplication,
  SuggestResponse,
  AuditEvent,
} from './types'

export type PreviewAction = 'approve' | 'reject' | 'request_info'

function daysAgo(iso: string): number {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((Date.now() - t) / 86400_000))
}

function last9(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D+/g, '')
  return digits.slice(-9)
}

interface CustomElectrical {
  label: string
  amount: number
  qty: number
}

// Read the operator-set custom electrical charges out of special_requirements,
// which may be a JSON string or an object. Mirrors readCustomElectrical in
// Vendor360.tsx: parse, pull the electrical_custom array, coerce label to a
// string / amount to a number / qty to >= 1. Defaults to [] on any drift.
function readCustomElectrical(raw: unknown): CustomElectrical[] {
  let reqs: unknown = raw
  if (typeof raw === 'string') {
    try { reqs = JSON.parse(raw) } catch { return [] }
  }
  if (!reqs || typeof reqs !== 'object') return []
  const custom = (reqs as { electrical_custom?: unknown }).electrical_custom
  if (!Array.isArray(custom)) return []
  const out: CustomElectrical[] = []
  for (const row of custom) {
    if (!row || typeof row !== 'object') continue
    const r = row as { label?: unknown; amount?: unknown; qty?: unknown }
    const label = typeof r.label === 'string' ? r.label : ''
    const amount = Number(r.amount) || 0
    const qty = Math.max(1, Math.floor(Number(r.qty) || 1))
    out.push({ label, amount, qty })
  }
  return out
}

// Parse special_requirements (JSON string or object) to a plain object so we
// can merge a fresh electrical_custom override for the live total recompute.
function parseReqs(raw: unknown): Record<string, unknown> {
  let reqs: unknown = raw
  if (typeof raw === 'string') {
    try { reqs = JSON.parse(raw) } catch { return {} }
  }
  if (!reqs || typeof reqs !== 'object' || Array.isArray(reqs)) return {}
  return reqs as Record<string, unknown>
}

function CompletenessBadge({ score }: { score: number | null | undefined }) {
  const s = typeof score === 'number' ? score : 0
  const tone =
    s >= 80 ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : s >= 50 ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-rose-50 text-rose-700 border-rose-200'
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold tabular-nums', tone)}>
      {s}/100
    </span>
  )
}

export interface PreviewPaneProps {
  row: WorkbenchApplication | null
  duplicateSiblings: WorkbenchApplication[]
  onApprove: (id: string) => void | Promise<unknown>
  onReject: (id: string) => void | Promise<unknown>
  onRequestInfo: (id: string) => void | Promise<unknown>
  onReopen?: (id: string) => void | Promise<unknown>
}

export function PreviewPane({
  row,
  duplicateSiblings,
  onApprove,
  onReject,
  onRequestInfo,
  onReopen,
}: PreviewPaneProps) {
  const [suggest, setSuggest] = useState<SuggestResponse | null>(null)
  const [suggestErr, setSuggestErr] = useState(false)
  const [events, setEvents] = useState<AuditEvent[]>([])
  // Activity list is gated: 460 rows x j/k = 460 events calls is wasteful.
  // Operator opts in per row by clicking "Show activity".
  const [showEvents, setShowEvents] = useState(false)
  // Tracks which mouse-driven action is currently in flight so we can
  // disable the toolbar + show a spinner. Keyed by action, not by row id,
  // because only one row is focused at a time.
  const [pendingAction, setPendingAction] = useState<PreviewAction | null>(null)

  // Operator-set custom electrical charges. Samreen adds charges here at
  // approval time for appliances the vendor under-declared (e.g. picked None
  // but listed real equipment in free-text). Saved to special_requirements
  // .electrical_custom; computeVendorPricing folds them into the total.
  const [customElec, setCustomElec] = useState<CustomElectrical[]>([])
  const [savingElec, setSavingElec] = useState(false)
  const [elecMsg, setElecMsg] = useState<string | null>(null)

  // Reset event-pane state whenever the focused row changes so the previous
  // row's events don't ghost into the next one. Also clear stale pending
  // state so the toolbar isn't disabled when we land on the new row. Re-seed
  // the custom-electrical editor from the new row so charges don't leak across.
  useEffect(() => {
    setEvents([])
    setShowEvents(false)
    setPendingAction(null)
    setCustomElec(readCustomElectrical(row?.special_requirements))
    setSavingElec(false)
    setElecMsg(null)
  }, [row?.id])

  // Pull suggestions whenever the focused row changes. Best-effort.
  // 250ms debounce + AbortController so a fast j/k walk through the queue
  // doesn't fire one /suggest call per row (was 460 Haiku calls on a full pass).
  useEffect(() => {
    if (!row) {
      setSuggest(null)
      setSuggestErr(false)
      return
    }
    const controller = new AbortController()
    setSuggest(null)
    setSuggestErr(false)
    const timer = setTimeout(() => {
      fetch(`/api/admin/applications/suggest?id=${row.id}`, { signal: controller.signal })
        .then(async (res) => {
          if (res.ok) {
            const data = (await res.json()) as SuggestResponse
            setSuggest(data)
          } else {
            setSuggestErr(true)
          }
        })
        .catch((err) => {
          if ((err as Error).name !== 'AbortError') setSuggestErr(true)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [row?.id])

  // Audit log: only fetch when the operator explicitly asks for it.
  // Same 250ms debounce + AbortController shape as the suggest fetch.
  useEffect(() => {
    if (!row || !showEvents) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/admin/applications/events?application_id=${row.id}&limit=20`, { signal: controller.signal })
        .then(async (res) => {
          if (res.ok) {
            const data = await res.json()
            setEvents(data.events ?? [])
          }
        })
        .catch((err) => {
          if ((err as Error).name !== 'AbortError') setEvents([])
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [row?.id, showEvents])

  if (!row) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-neutral-400">
        Select a row to preview.
      </div>
    )
  }

  const age = daysAgo(row.created_at)
  const phoneLast9 = last9(row.phone)
  const isDupeFromPhone = duplicateSiblings.length > 0
  const isDuplicate = row.is_duplicate || isDupeFromPhone

  // Merge the live editor state over the row's parsed requirements so the
  // recomputed total reflects what Samreen is typing before she saves.
  const parsedReqs = parseReqs(row.special_requirements)
  const livePricing = computeVendorPricing({
    preferred_booth_tier: row.preferred_booth_tier,
    special_requirements: { ...parsedReqs, electrical_custom: customElec },
  })

  // Persist the custom charges. Drop blank-label rows, coerce amount/qty, then
  // PATCH /api/admin/vendors/[id] with { electrical_custom } (the route merges
  // into special_requirements without clobbering electrical_appliances). Stays
  // on the row on success so she can review the corrected total then approve.
  async function handleSaveElec() {
    if (!row) return
    setSavingElec(true)
    setElecMsg(null)
    try {
      const electrical_custom = customElec
        .filter((c) => (Number(c.amount) || 0) > 0)
        .map((c) => ({
          label: c.label.trim() || 'Additional charge',
          amount: Number(c.amount) || 0,
          qty: Math.max(1, Math.floor(Number(c.qty) || 1)),
        }))
      const r = await fetch(`/api/admin/vendors/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ electrical_custom }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setElecMsg(j.error || 'Failed to save charges'); return }
      setCustomElec(readCustomElectrical({ ...parsedReqs, electrical_custom }))
      setElecMsg('Saved')
    } catch (e) {
      setElecMsg((e as Error).message || 'Failed to save charges')
    } finally {
      setSavingElec(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-5 space-y-5">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-neutral-900 truncate">{row.business_name}</h2>
              <p className="text-sm text-neutral-500 truncate">{row.contact_name}</p>
            </div>
            <Link
              href={`/admin/vendors/${row.id}`}
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-neutral-200 hover:border-neutral-400 text-neutral-700"
            >
              Open full profile <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-neutral-100 text-[11px] text-neutral-700 capitalize">
              {row.status.replace('_', ' ')}
            </span>
            <CompletenessBadge score={suggest?.completeness_score ?? row.completeness_score} />
            <span className="text-[11px] tabular-nums text-neutral-500">{age}d old</span>
            {isDuplicate && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-[11px]">
                <AlertTriangle className="w-3 h-3" /> possible duplicate
              </span>
            )}
          </div>
        </div>

        {/* Mouse-only action toolbar.
            Sits BELOW the status pill / score / age line and ABOVE contact.
            Mirrors the keyboard layer (a / r / i) so admin can clear the
            queue without learning the shortcuts. Already-decided rows
            collapse this row down to a status pill (and optional Reopen),
            so we never re-fire approve/reject on a terminal row. */}
        <PreviewActionToolbar
          row={row}
          pendingAction={pendingAction}
          onApprove={async () => {
            setPendingAction('approve')
            try { await onApprove(row.id) } finally { setPendingAction(null) }
          }}
          onRequestInfo={async () => {
            setPendingAction('request_info')
            try { await onRequestInfo(row.id) } finally { setPendingAction(null) }
          }}
          onReject={async () => {
            setPendingAction('reject')
            try { await onReject(row.id) } finally { setPendingAction(null) }
          }}
          onReopen={onReopen ? () => onReopen(row.id) : undefined}
        />

        {/* Payment & Allocation Status */}
        <div className="px-5 py-3 bg-neutral-50 border-t border-neutral-100 -mx-5">
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-full ${
                row.payment_status === 'paid' ? 'bg-emerald-500' :
                row.payment_status === 'pending' ? 'bg-amber-500' : 'bg-neutral-300'
              }`} />
              Payment: {row.payment_status || 'none'}
            </span>
            <span>Docs: {row.docCount ?? 0}/3</span>
            <span>Contract: {row.contract_signed ? 'Signed' : 'Pending'}</span>
            <span>Stall: {row.stall_code || 'Unallocated'}</span>
          </div>
        </div>

        {/* Contact + categories */}
        <section className="space-y-2 text-sm">
          <div className="flex items-center gap-2 text-neutral-700">
            <Mail className="w-3.5 h-3.5 text-neutral-400" />
            <a className="hover:underline truncate" href={`mailto:${row.email}`}>{row.email}</a>
          </div>
          <div className="flex items-center gap-2 text-neutral-700">
            <Phone className="w-3.5 h-3.5 text-neutral-400" />
            <span className="tabular-nums">{row.phone || '—'}</span>
            {phoneLast9 && (
              <span className="text-[10px] text-neutral-400">…{phoneLast9}</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-neutral-700">
            <Building2 className="w-3.5 h-3.5 text-neutral-400" />
            <span>{row.preferred_booth_tier || 'no tier preference'}</span>
          </div>
        </section>

        {/* Product categories */}
        <section className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-neutral-400">Categories</div>
          <div className="flex flex-wrap gap-1.5">
            {(row.product_categories ?? []).length > 0 ? (
              row.product_categories!.map((c) => (
                <span key={c} className="px-2 py-0.5 rounded-full bg-neutral-100 text-[11px] text-neutral-700">
                  {c}
                </span>
              ))
            ) : (
              <span className="text-[11px] text-neutral-400">none</span>
            )}
          </div>
          {row.sector && (
            <div className="text-[11px] text-neutral-500 pt-1">
              Sector: <span className="font-medium text-neutral-700">{row.sector}</span>
            </div>
          )}
        </section>

        {/* AI suggestions */}
        <section className="space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-neutral-400">AI suggested sector</div>
            {suggestErr && (
              <span className="text-[10px] text-neutral-400">suggest offline</span>
            )}
          </div>
          {suggest?.sector_suggestions?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {suggest.sector_suggestions.map((s) => (
                <span
                  key={s.value}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 text-[11px]"
                >
                  <Tag className="w-3 h-3" />
                  {s.value}
                  <span className="text-[10px] text-violet-500 tabular-nums">
                    {Math.round(s.confidence * 100)}%
                  </span>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-neutral-400">
              {suggest === null && !suggestErr ? 'loading…' : 'no suggestion'}
            </div>
          )}
        </section>

        {/* Business description */}
        <section className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-neutral-400">Description</div>
          <p className="text-sm text-neutral-700 whitespace-pre-wrap">
            {row.business_description?.trim() || <span className="text-neutral-400">not provided</span>}
          </p>
        </section>

        {/* Special requirements: the application form POSTs this as a JSON
            blob (stall_type, stall_price, electrical_appliances, etc).
            Parse + render as labeled rows. Fallback to plain text if the
            shape ever drifts. Strip em-dashes on display (Law 7). */}
        {row.special_requirements && (
          <section className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-neutral-400">Special requirements</div>
            <SpecialRequirementsView raw={row.special_requirements} />
          </section>
        )}

        {/* Operator electrical charges. Vendors game the electrical fee by
            picking "None" and listing real appliances in free-text. Samreen
            adds the missing charges here at approval time; they fold into the
            total via computeVendorPricing and persist to electrical_custom. */}
        <section className="space-y-2">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-400">
            <Zap className="w-3 h-3" /> Additional charges (operator)
          </div>
          <p className="text-[11px] text-neutral-500">
            Add a charge to this vendor (off-list appliances, extra space, or any additional payment request). Each adds to their total and what they pay.
          </p>
          <div className="space-y-1.5">
            {customElec.map((charge, i) => {
              const subtotal = (Number(charge.amount) || 0) * Math.max(1, Math.floor(Number(charge.qty) || 1))
              return (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={charge.label}
                    onChange={(e) => setCustomElec((prev) =>
                      prev.map((r, idx) => idx === i ? { ...r, label: e.target.value } : r)
                    )}
                    placeholder="e.g. 2 x Slurpee machine"
                    aria-label="Charge label"
                    className="flex-1 min-w-0 border border-neutral-200 rounded px-2 py-1 text-[12px]"
                  />
                  <input
                    type="number"
                    value={charge.amount}
                    onChange={(e) => setCustomElec((prev) =>
                      prev.map((r, idx) => idx === i ? { ...r, amount: Number(e.target.value) } : r)
                    )}
                    placeholder="R / unit"
                    aria-label="Amount in Rand per unit"
                    className="w-16 shrink-0 border border-neutral-200 rounded px-2 py-1 text-[12px] tabular-nums"
                  />
                  <input
                    type="number"
                    min={1}
                    value={charge.qty}
                    onChange={(e) => setCustomElec((prev) =>
                      prev.map((r, idx) => idx === i ? { ...r, qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) } : r)
                    )}
                    aria-label="Quantity"
                    className="w-12 shrink-0 border border-neutral-200 rounded px-2 py-1 text-[12px] tabular-nums"
                  />
                  <span className="w-16 shrink-0 text-right text-[11px] text-neutral-500 tabular-nums">
                    {formatRand(subtotal)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCustomElec((prev) => prev.filter((_, idx) => idx !== i))}
                    aria-label="Remove charge"
                    className="w-5 h-5 shrink-0 rounded border border-neutral-200 text-neutral-500 hover:bg-neutral-50 inline-flex items-center justify-center"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setCustomElec((prev) => [...prev, { label: '', amount: 0, qty: 1 }])}
              className="text-[11px] text-neutral-600 hover:text-neutral-900 inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              <Plus className="w-3 h-3" /> Add charge
            </button>
            <span className="text-[11px] font-medium text-neutral-700 tabular-nums">
              New total: {formatRand(livePricing.total)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveElec}
              disabled={savingElec}
              className="px-2.5 py-1 rounded text-[11px] font-medium flex items-center gap-1.5 bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {savingElec ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Save charges
            </button>
            {elecMsg && (
              <span className={cn('text-[11px]', elecMsg === 'Saved' ? 'text-emerald-600' : 'text-rose-600')}>
                {elecMsg}
              </span>
            )}
          </div>
        </section>

        {/* Duplicate siblings */}
        {duplicateSiblings.length > 0 && (
          <section className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-neutral-400">
              Same phone (last 9): {duplicateSiblings.length} other row(s)
            </div>
            <ul className="text-[12px] text-neutral-700 space-y-0.5">
              {duplicateSiblings.map((d) => (
                <li key={d.id} className="truncate">
                  <Link href={`/admin/applications/${d.id}`} className="hover:underline">
                    {d.business_name}
                  </Link>
                  <span className="text-neutral-400"> · {d.status} · {daysAgo(d.created_at)}d</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Audit log — gated to keep j/k walks cheap. */}
        <section className="space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-neutral-400">Activity</div>
            {!showEvents && (
              <button
                type="button"
                onClick={() => setShowEvents(true)}
                className="text-[11px] text-neutral-600 hover:text-neutral-900 underline-offset-2 hover:underline"
              >
                Show activity
              </button>
            )}
          </div>
          {!showEvents ? (
            <div className="text-[11px] text-neutral-400">Activity hidden by default.</div>
          ) : events.length === 0 ? (
            <div className="text-[11px] text-neutral-400">No activity yet.</div>
          ) : (
            <ul className="space-y-1">
              {events.map((ev) => (
                <li key={ev.id} className="text-[12px] text-neutral-700">
                  <span className="font-medium">{ev.event_type}</span>
                  {ev.actor_email && (
                    <span className="text-neutral-500"> by {ev.actor_email}</span>
                  )}
                  <span className="text-neutral-400"> · {new Date(ev.created_at).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  {ev.note && <div className="text-neutral-500 italic truncate">{ev.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function PreviewActionToolbar({
  row,
  pendingAction,
  onApprove,
  onRequestInfo,
  onReject,
  onReopen,
}: {
  row: WorkbenchApplication
  pendingAction: PreviewAction | null
  onApprove: () => void
  onRequestInfo: () => void
  onReject: () => void
  onReopen?: () => void
}) {
  const status = row.status
  // Terminal rows: show a status pill instead of action buttons so we
  // can't accidentally re-approve or re-reject. Reopen is offered when
  // the parent wired a handler.
  if (status === 'approved' || status === 'rejected') {
    const when = row.approved_at
      ? new Date(row.approved_at).toLocaleString('en-ZA', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : null
    const verb = status === 'approved' ? 'approved' : 'rejected'
    const label = when ? `Already ${verb} on ${when}` : `Already ${verb}`
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium',
            status === 'approved'
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : 'bg-rose-50 text-rose-700 border border-rose-200'
          )}
        >
          {status === 'approved' ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <XCircle className="w-4 h-4" />
          )}
          {label}
        </span>
        {onReopen && (
          <button
            type="button"
            onClick={onReopen}
            className="px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 border border-neutral-200 text-neutral-700 hover:bg-neutral-50"
          >
            <RotateCcw className="w-4 h-4" /> Reopen
          </button>
        )}
      </div>
    )
  }

  const anyPending = pendingAction !== null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onApprove}
        disabled={anyPending}
        className="px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 bg-[#cd2653] text-white hover:bg-[#b01f45] disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {pendingAction === 'approve' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <CheckCircle2 className="w-4 h-4" />
        )}
        Approve
      </button>
      <button
        type="button"
        onClick={onRequestInfo}
        disabled={anyPending}
        className="px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 border border-neutral-200 text-neutral-700 hover:bg-neutral-50 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {pendingAction === 'request_info' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <HelpCircle className="w-4 h-4" />
        )}
        Request info
      </button>
      <button
        type="button"
        onClick={onReject}
        disabled={anyPending}
        className="px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {pendingAction === 'reject' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <XCircle className="w-4 h-4" />
        )}
        Reject
      </button>
    </div>
  )
}

const FIELD_LABELS: Record<string, string> = {
  traded_before: 'Traded before',
  social_media: 'Social media',
  stall_type: 'Stall type',
  stall_price: 'Stall price',
  electrical_appliances: 'Electrical appliances',
  appliance_details: 'Appliance details',
  uses_gas: 'Uses gas',
  total_estimate: 'Total estimate',
  power_supply: 'Power supply',
  water_required: 'Water required',
  notes: 'Notes',
}

function humaniseKey(k: string): string {
  if (FIELD_LABELS[k]) return FIELD_LABELS[k]
  return k.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatValue(k: string, v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') {
    if (/price|estimate|cost|fee/i.test(k)) return `R${v.toLocaleString('en-ZA')}`
    return String(v)
  }
  const s = String(v).trim()
  return s.replace(/—/g, ' to ').replace(/–/g, ' to ')
}

function SpecialRequirementsView({ raw }: { raw: string }) {
  let parsed: Record<string, unknown> | null = null
  try {
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const candidate = JSON.parse(trimmed)
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>
      }
    }
  } catch {
    parsed = null
  }

  if (!parsed) {
    return (
      <p className="text-sm text-neutral-700 whitespace-pre-wrap">
        {raw.replace(/—/g, ' to ').replace(/–/g, ' to ')}
      </p>
    )
  }

  const rows = Object.entries(parsed).filter(([, v]) => {
    if (v === null || v === undefined) return false
    const s = String(v).trim()
    return s.length > 0
  })

  if (rows.length === 0) {
    return <p className="text-sm text-neutral-400">No special requirements provided.</p>
  }

  return (
    <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-neutral-500 sm:text-right">{humaniseKey(k)}</dt>
          <dd className="text-neutral-800 whitespace-pre-wrap break-words">{formatValue(k, v)}</dd>
        </div>
      ))}
    </dl>
  )
}
