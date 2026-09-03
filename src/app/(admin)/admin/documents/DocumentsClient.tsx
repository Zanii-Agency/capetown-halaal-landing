'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, Clock, Loader2, Search, X } from 'lucide-react'
import {
  PageShell, PageHeader, Card,
} from '@/components/chrome/PageChrome'
import { DOC_LABEL } from '@/lib/exhibitor/required-docs'
import { DocViewerDrawer } from '@/components/admin/documents/DocViewerDrawer'

interface VendorDocRow {
  application_id: string
  business_name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  application_status: string | null
  doc_type: string
  doc_name: string
  doc_status: 'pending' | 'approved' | 'rejected'
  uploaded_at: string
  storage_path: string
  note: string | null
}

// One card row per vendor: their identity plus every document they have
// uploaded, collapsed onto a single line of status chips.
interface VendorGroup {
  application_id: string
  business_name: string
  contact_name: string | null
  email: string | null
  docs: VendorDocRow[]
  latest_at: string
}

function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-ZA', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function titleize(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function docTypeLabel(type: string): string {
  const known = (DOC_LABEL as Record<string, string>)[type]
  return known || titleize(type)
}

// Short label for the on-line chips. The full DOC_LABEL strings ("Halaal
// certificate or declaration") are too long to fit several per row.
const DOC_SHORT: Record<string, string> = {
  halaal_cert: 'Halaal',
  health_permit: 'Health',
  gas_cert: 'Gas',
  public_liability: 'Liability',
  electrical_coc: 'Electrical',
  fire_safety: 'Fire',
  indemnity: 'Indemnity',
  vendor_contract: 'Contract',
  other: 'Other',
}

function docShort(type: string): string {
  return DOC_SHORT[type] || titleize(type)
}

// Chip styling + icon per doc status. Mirrors the vendors-list blockers chips.
function chipTone(s: VendorDocRow['doc_status']) {
  if (s === 'approved') return { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: Check }
  if (s === 'rejected') return { cls: 'bg-rose-50 text-rose-700 border-rose-200', Icon: X }
  return { cls: 'bg-amber-50 text-amber-700 border-amber-200', Icon: Clock }
}

// Resolve the URL the inline viewer should load for a vendor doc row.
// `contract:<application_id>` is the sentinel emitted by the synthetic
// contract row in /api/admin/documents/vendors and points the viewer at
// the admin-gated contract PDF route. Everything else flows through the
// existing vendor-doc signed-URL endpoint.
function vendorDocUrl(row: VendorDocRow): string {
  if (row.storage_path.startsWith('contract:')) {
    return `/api/admin/applications/${row.application_id}/contract/pdf`
  }
  return `/api/admin/vendor-doc?path=${encodeURIComponent(row.storage_path)}`
}

interface ViewerState {
  open: boolean
  url: string | null
  label: string
  holder: string | null
}

const VIEWER_CLOSED: ViewerState = { open: false, url: null, label: '', holder: null }

export function DocumentsClient() {
  const [search, setSearch] = useState('')
  const [docTypeFilter, setDocTypeFilter] = useState('')
  const [docStatusFilter, setDocStatusFilter] = useState('')

  const [vendorRows, setVendorRows] = useState<VendorDocRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Inline viewer state. We only ever surface one PDF at a time so a single
  // state slot is enough.
  const [viewer, setViewer] = useState<ViewerState>(VIEWER_CLOSED)

  // Debounce search so we are not firing on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => clearTimeout(id)
  }, [search])

  // Load vendor docs
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (docTypeFilter) params.set('doc_type', docTypeFilter)
    if (docStatusFilter) params.set('status', docStatusFilter)
    fetch(`/api/admin/documents/vendors?${params.toString()}`)
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          window.location.href = '/admin/login'
          return
        }
        if (!res.ok) throw new Error(`Server ${res.status}`)
        const body = await res.json()
        if (!cancelled) setVendorRows(body.rows || [])
      })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [debouncedSearch, docTypeFilter, docStatusFilter])

  // Unique doc types for the filter dropdown. Derived from the loaded rows so
  // the option list always matches reality.
  const docTypeOptions = useMemo(() => {
    const set = new Set<string>()
    ;(vendorRows || []).forEach((r) => set.add(r.doc_type))
    return Array.from(set).sort()
  }, [vendorRows])

  // Collapse the flat doc rows into one group per vendor. The API already
  // sorts rows by uploaded_at desc, so first-seen order keeps vendors sorted
  // by most-recent activity.
  const groups = useMemo<VendorGroup[]>(() => {
    const byVendor = new Map<string, VendorGroup>()
    for (const r of vendorRows || []) {
      let g = byVendor.get(r.application_id)
      if (!g) {
        g = {
          application_id: r.application_id,
          business_name: r.business_name,
          contact_name: r.contact_name,
          email: r.email,
          docs: [],
          latest_at: r.uploaded_at,
        }
        byVendor.set(r.application_id, g)
      }
      g.docs.push(r)
      if ((r.uploaded_at || '') > (g.latest_at || '')) g.latest_at = r.uploaded_at
    }
    return Array.from(byVendor.values())
  }, [vendorRows])

  return (
    <PageShell>
      <PageHeader
        kicker="Operations"
        title="Documents"
        subtitle="Every vendor's uploads summarised on one row. Click any document chip to preview the file inline."
      />

      <div className="space-y-4">
        {/* Filter row */}
        <Card>
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1B1A17]/45" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search vendor, contact, or email"
                className="w-full pl-9 pr-3 py-2.5 rounded-full border border-[#E5E5E5]/40 bg-[#FFFFFF] text-sm focus:outline-none focus:border-[#cd2653]/60"
              />
            </div>

            <select
              value={docTypeFilter}
              onChange={(e) => setDocTypeFilter(e.target.value)}
              className="px-3 py-2.5 rounded-full border border-[#E5E5E5]/40 bg-[#FFFFFF] text-sm focus:outline-none focus:border-[#cd2653]/60"
            >
              <option value="">All document types</option>
              {docTypeOptions.map((t) => (
                <option key={t} value={t}>{docTypeLabel(t)}</option>
              ))}
            </select>
            <select
              value={docStatusFilter}
              onChange={(e) => setDocStatusFilter(e.target.value)}
              className="px-3 py-2.5 rounded-full border border-[#E5E5E5]/40 bg-[#FFFFFF] text-sm focus:outline-none focus:border-[#cd2653]/60"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
        </Card>

        {error && (
          <Card>
            <p className="text-sm text-[#bf3026]">{error}</p>
          </Card>
        )}

        <Card padded={false} className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.14em] text-[#1B1A17]/55 border-b border-[#E5E5E5]/30 bg-[#FFFFFF]/40">
                  <th className="p-3 font-bold">Vendor</th>
                  <th className="p-3 font-bold">Documents</th>
                  <th className="p-3 font-bold text-right">Last upload</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={3} className="p-8 text-center">
                      <Loader2 className="w-5 h-5 animate-spin text-[#1B1A17]/45 mx-auto" />
                    </td>
                  </tr>
                )}
                {!loading && vendorRows && groups.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-8 text-center text-[#1B1A17]/45 text-sm">
                      No documents match these filters.
                    </td>
                  </tr>
                )}
                {!loading && groups.map((g) => (
                  <tr key={g.application_id} className="border-b border-[#E5E5E5]/15 last:border-b-0 hover:bg-[#FFFFFF]/60 align-top">
                    <td className="p-3">
                      <p className="text-sm font-medium text-[#1B1A17]">{g.business_name}</p>
                      <p className="text-xs text-[#1B1A17]/45">
                        {[g.contact_name, g.email].filter(Boolean).join(' · ')}
                      </p>
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1.5">
                        {g.docs.map((d, i) => {
                          const { cls, Icon } = chipTone(d.doc_status)
                          return (
                            <button
                              key={`${d.doc_type}-${i}`}
                              type="button"
                              title={`${docTypeLabel(d.doc_type)} · ${d.doc_name} · ${d.doc_status}`}
                              onClick={() => setViewer({
                                open: true,
                                url: vendorDocUrl(d),
                                label: `${docTypeLabel(d.doc_type)} · ${d.doc_name}`,
                                holder: g.business_name,
                              })}
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border text-[11px] font-medium transition hover:brightness-95 ${cls}`}
                            >
                              <Icon className="w-3 h-3" /> {docShort(d.doc_type)}
                            </button>
                          )
                        })}
                      </div>
                    </td>
                    <td className="p-3 text-right whitespace-nowrap">
                      <span className="text-sm text-[#1B1A17]/70">{formatDateTime(g.latest_at)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <DocViewerDrawer
        open={viewer.open}
        url={viewer.url}
        label={viewer.label}
        holder={viewer.holder}
        onClose={() => setViewer(VIEWER_CLOSED)}
      />
    </PageShell>
  )
}
