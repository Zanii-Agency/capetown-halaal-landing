'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Search, Phone, Mail, MapPin, FileCheck, AlertTriangle, Users, Send, Download, Loader2 } from 'lucide-react'
import { VendorBulkComposer } from './VendorBulkComposer'

export interface VendorRow {
  id: string
  business_name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  categories: string[]
  tier_label: string
  stall_type: string
  appliances: string
  appliance_details: string
  uses_gas: string
  stall: string | null
  stall_status: string | null
  payment_status: string
  payment_amount: number | null
  docs_count: number
  contract_signed: boolean
  docs_complete_at: string | null
  contract_signed_at: string | null
  blockers: string[]
  created_at: string
}

type Filter = 'all' | 'has_blockers' | 'ready' | 'unallocated'

const PAYMENT_PILL: Record<string, string> = {
  paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  waived: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending: 'bg-blue-50 text-blue-700 border-blue-200',
  deferred: 'bg-neutral-50 text-neutral-600 border-neutral-200',
  none: 'bg-rose-50 text-rose-700 border-rose-200',
}

// Approved vendors list. Designed for Samreen's morning sweep: scan blockers
// at a glance, click into the profile for the full A-Z view.
export function VendorsList({ rows }: { rows: VendorRow[] }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [viewMode, setViewMode] = useState<'table' | 'pipeline'>('table')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [composerOpen, setComposerOpen] = useState(false)
  const [exporting, setExporting] = useState<false | 'csv' | 'xlsx'>(false)

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAllVisible(visibleIds: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of visibleIds) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function runExport(kind: 'csv' | 'xlsx') {
    setExporting(kind)
    try {
      const params = new URLSearchParams()
      if (selected.size > 0) params.set('ids', Array.from(selected).join(','))
      else params.set('status', 'approved')
      const path = kind === 'xlsx' ? 'export' : 'csv'
      const url = `/api/admin/vendors/${path}?${params.toString()}`
      // Fetch first, check res.ok, only download on success. An error body
      // must NEVER be saved to disk (was saving the JSON error as csv.json).
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) {
        let message = `Export failed (${res.status})`
        try {
          const body = await res.json()
          if (body?.error) message = String(body.error)
        } catch {
          // non-JSON error body, keep the status-based message
        }
        // Distinguish a permissions issue (403) from a real server bug (500).
        if (res.status === 401 || res.status === 403) {
          toast.error("You don't have permission to export. Ask the owner to grant access.")
        } else {
          toast.error(`Export failed: ${message}`)
        }
        return
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `vendors-${new Date().toISOString().slice(0, 10)}.${kind === 'xlsx' ? 'xlsx' : 'csv'}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(objectUrl)
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : 'network error'}`)
    } finally {
      setExporting(false)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'has_blockers' && r.blockers.length === 0) return false
      if (filter === 'ready' && r.blockers.length > 0) return false
      if (filter === 'unallocated' && r.stall) return false
      if (!q) return true
      const hay = `${r.business_name} ${r.contact_name || ''} ${r.email || ''} ${r.phone || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [rows, query, filter])

  const counts = useMemo(() => ({
    all: rows.length,
    has_blockers: rows.filter((r) => r.blockers.length > 0).length,
    ready: rows.filter((r) => r.blockers.length === 0).length,
    unallocated: rows.filter((r) => !r.stall).length,
  }), [rows])

  return (
    <div className="p-6 sm:p-8 max-w-7xl">
      <div className="flex items-end justify-between gap-4 mb-5 flex-wrap">
        <div>
          <p className="text-xs font-semibold text-[#cd2653] uppercase tracking-[0.2em]">VENDORS</p>
          <h1 className="text-2xl font-bold text-neutral-900">Approved vendors</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {rows.length} approved, {filtered.length} shown.
          </p>
        </div>
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
          <input
            type="text"
            placeholder="Search business, contact, phone, email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#cd2653] focus:border-transparent"
          />
        </div>
      </div>

      {/* Bulk action toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          disabled={selected.size === 0}
          onClick={() => setComposerOpen(true)}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border',
            selected.size === 0
              ? 'border-neutral-200 text-neutral-400 cursor-not-allowed'
              : 'border-[#cd2653] bg-[#cd2653] text-white hover:bg-[#b01f45]'
          )}
        >
          <Send className="w-3.5 h-3.5" />
          Message selected ({selected.size})
        </button>
        <button
          type="button"
          onClick={() => runExport('xlsx')}
          disabled={!!exporting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-[#1f7050] bg-[#1f7050] text-white hover:bg-[#1a5e43] disabled:opacity-60"
        >
          {exporting === 'xlsx' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          Export Excel ({selected.size > 0 ? `${selected.size} selected` : 'all approved'})
        </button>
        <button
          type="button"
          onClick={() => runExport('csv')}
          disabled={!!exporting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-neutral-300 text-neutral-700 hover:border-neutral-500 disabled:opacity-60"
        >
          {exporting === 'csv' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          CSV
        </button>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-xs text-neutral-500 hover:underline"
          >
            Clear selection
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setViewMode('table')}
          className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${viewMode === 'table' ? 'bg-[#cd2653] text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'}`}>
          Table
        </button>
        <button onClick={() => setViewMode('pipeline')}
          className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${viewMode === 'pipeline' ? 'bg-[#cd2653] text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'}`}>
          Pipeline
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {([
          { k: 'all', label: 'All' },
          { k: 'has_blockers', label: 'Has blockers' },
          { k: 'ready', label: 'Ready' },
          { k: 'unallocated', label: 'No stall yet' },
        ] as const).map((opt) => (
          <button
            key={opt.k}
            type="button"
            onClick={() => setFilter(opt.k)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors',
              filter === opt.k
                ? 'bg-[#cd2653] text-white border-[#cd2653]'
                : 'bg-white text-neutral-700 border-neutral-200 hover:border-neutral-400'
            )}
          >
            {opt.label}
            <span className={cn(
              'text-[10px] px-1 rounded tabular-nums',
              filter === opt.k ? 'bg-white/20' : 'bg-neutral-100 text-neutral-500'
            )}>
              {counts[opt.k]}
            </span>
          </button>
        ))}
      </div>

      {viewMode === 'pipeline' ? (
        <PipelineView rows={filtered} />
      ) : (
      <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-neutral-500">
            <Users className="w-10 h-10 mb-3 text-neutral-300" />
            <p>No vendors match these filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="pl-4 pr-2 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every((r) => selected.has(r.id))}
                    onChange={(e) => selectAllVisible(filtered.map((r) => r.id), e.target.checked)}
                    aria-label="Select all visible"
                    className="rounded border-neutral-300"
                  />
                </th>
                <th className="px-4 py-2">Business</th>
                <th className="px-4 py-2">Contact</th>
                <th className="px-4 py-2 w-24">Stall</th>
                <th className="px-4 py-2 w-28">Payment</th>
                <th className="px-4 py-2 w-24">Contract</th>
                <th className="px-4 py-2 w-16">Docs</th>
                <th className="px-4 py-2 max-w-[220px]">Appliances</th>
                <th className="px-4 py-2">Blockers</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  data-testid="vendor-card"
                  className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/60"
                >
                  <td className="pl-4 pr-2 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleSelected(r.id)}
                      aria-label={`Select ${r.business_name}`}
                      className="rounded border-neutral-300"
                    />
                  </td>
                  <td className="px-4 py-3 max-w-[260px]">
                    <Link
                      href={`/admin/vendors/${r.id}`}
                      className="font-medium text-neutral-900 hover:text-[#cd2653] block truncate"
                      title={r.business_name}
                    >
                      {r.business_name}
                    </Link>
                    <p className="text-[11px] text-neutral-500 truncate" title={r.stall_type}>{r.stall_type || r.tier_label}</p>
                  </td>
                  <td className="px-4 py-3 max-w-[180px]">
                    <p className="text-neutral-700 truncate" title={r.contact_name || ''}>
                      {r.contact_name || '—'}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-neutral-500">
                      {r.phone && (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="w-3 h-3" /> {r.phone}
                        </span>
                      )}
                      {r.email && (
                        <span className="inline-flex items-center gap-1 truncate" title={r.email}>
                          <Mail className="w-3 h-3" /> {r.email}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {r.stall ? (
                      <span className="inline-flex items-center gap-1 text-[12px] font-mono font-semibold text-neutral-900">
                        <MapPin className="w-3 h-3 text-[#cd2653]" />
                        {r.stall}
                      </span>
                    ) : (
                      <Link
                        href={`/admin/allocation`}
                        className="text-[11px] text-[#cd2653] underline hover:no-underline"
                      >
                        assign
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium',
                      PAYMENT_PILL[r.payment_status] || PAYMENT_PILL.none
                    )}>
                      {r.payment_status}
                    </span>
                    {r.payment_amount ? (
                      <p className="text-[10px] text-neutral-500 mt-0.5 tabular-nums">
                        R{r.payment_amount.toLocaleString()}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {r.contract_signed ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
                        <FileCheck className="w-3 h-3" /> signed
                      </span>
                    ) : (
                      <span className="text-[11px] text-rose-600">unsigned</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[12px] tabular-nums text-neutral-700">
                    {r.docs_count}
                  </td>
                  <td className="px-4 py-3 max-w-[220px] align-top">
                    {r.appliances ? (
                      <p className="text-[11px] text-neutral-700 line-clamp-2" title={`${r.appliances}${r.appliance_details ? `\n\nNotes: ${r.appliance_details}` : ''}${r.uses_gas ? `\n\nGas: ${r.uses_gas}` : ''}`}>
                        {r.appliances}
                      </p>
                    ) : (
                      <span className="text-[11px] text-neutral-400">none</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {r.blockers.length === 0 ? (
                      <span className="text-[11px] text-emerald-700">ready</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {r.blockers.map((b) => (
                          <span
                            key={b}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-medium"
                          >
                            <AlertTriangle className="w-2.5 h-2.5" /> {b}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
      )}

      {composerOpen && (
        <VendorBulkComposer
          recipients={rows
            .filter((r) => selected.has(r.id))
            .map((r) => ({
              id: r.id,
              business_name: r.business_name,
              contact_name: r.contact_name,
              email: r.email,
              phone: r.phone,
              stall: r.stall,
            }))}
          onClose={() => setComposerOpen(false)}
        />
      )}
    </div>
  )
}

const PIPELINE_STAGES = [
  { key: 'approved', label: 'Approved', filter: (r: VendorRow) => !r.contract_signed_at },
  { key: 'contract', label: 'Contract', filter: (r: VendorRow) => r.contract_signed_at && r.payment_status !== 'paid' && r.payment_status !== 'deferred' },
  { key: 'paid', label: 'Paid', filter: (r: VendorRow) => r.payment_status === 'paid' || r.payment_status === 'deferred' },
  { key: 'ready', label: 'Show-ready', filter: (r: VendorRow) => r.payment_status === 'paid' && r.docs_complete_at },
]

function PipelineView({ rows }: { rows: VendorRow[] }) {
  return (
    <div className="grid grid-cols-4 gap-4">
      {PIPELINE_STAGES.map(stage => {
        const stageRows = rows.filter(stage.filter)
        return (
          <div key={stage.key} className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-100 bg-neutral-50">
              <p className="text-xs font-semibold text-neutral-500 uppercase">{stage.label}</p>
              <p className="text-lg font-semibold text-neutral-800">{stageRows.length}</p>
            </div>
            <div className="p-2 space-y-1 max-h-[60vh] overflow-y-auto">
              {stageRows.length === 0 ? (
                <p className="text-xs text-neutral-400 text-center py-4">No vendors</p>
              ) : (
                stageRows.map((row: VendorRow) => (
                  <a key={row.id} href={`/admin/vendors/${row.id}`}
                    className="block px-3 py-2 rounded-lg text-sm hover:bg-neutral-50 transition-colors">
                    <p className="font-medium text-neutral-800 truncate">{row.business_name}</p>
                    <p className="text-xs text-neutral-400 truncate">{row.contact_name} · {row.phone}</p>
                  </a>
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
