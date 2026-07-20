'use client'

// Required-documents checklist for the admin vendor profile. Shows, for each
// required doc slot, whether the vendor has it (approved / awaiting review /
// rejected) or is still missing it, plus a one-click "Request documents" action
// that fires the Meta-approved WhatsApp template + matching email for the docs
// that are still outstanding. Pure presentational + one fetch (best-effort).
//
// No em-dashes anywhere vendor-facing (CTH-DOCTRINE Law 7).

import { useState } from 'react'
import { Check, Clock, X, AlertCircle, Loader2, Send } from 'lucide-react'
import { StatusPill } from '@/components/chrome/StatusPill'
import { REQUIRED_DOC_TYPES, REQUIRED_DOC_LABELS } from '@/app/(admin)/admin/vendors/[id]/doc-types'
import type { DocRecord } from '@/lib/portal-state'

type SlotState = 'approved' | 'pending' | 'rejected' | 'missing'

// For a required doc type, find the most recent matching upload and derive its
// checklist state. "Pending" is the portal's word for "uploaded, awaiting
// review". A type with no matching upload at all is "missing".
function slotStateFor(type: string, docs: DocRecord[]): SlotState {
  const matches = docs.filter((d) => d.type === type)
  if (matches.length === 0) return 'missing'
  // Prefer the freshest record so a re-upload after a rejection wins.
  const latest = matches.reduce((a, b) =>
    new Date(b.uploaded_at || 0).getTime() >= new Date(a.uploaded_at || 0).getTime() ? b : a
  )
  if (latest.status === 'approved') return 'approved'
  if (latest.status === 'rejected') return 'rejected'
  return 'pending'
}

const STATE_META: Record<SlotState, {
  tone: 'success' | 'warn' | 'danger' | 'neutral'
  label: string
  icon: React.ReactNode
}> = {
  approved: { tone: 'success', label: 'Approved', icon: <Check className="w-4 h-4 text-[#16A34A]" /> },
  pending: { tone: 'warn', label: 'Uploaded, awaiting review', icon: <Clock className="w-4 h-4 text-[#D97706]" /> },
  rejected: { tone: 'danger', label: 'Rejected, re-upload needed', icon: <X className="w-4 h-4 text-[#DC2626]" /> },
  missing: { tone: 'neutral', label: 'Missing', icon: <AlertCircle className="w-4 h-4 text-[#6B7280]" /> },
}

export function VendorDocsChecklist({
  applicationId,
  docs,
}: {
  applicationId: string
  docs: import('@/lib/portal-state').DocRecord[]
}) {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rows = REQUIRED_DOC_TYPES.map((type) => ({
    type,
    label: REQUIRED_DOC_LABELS[type] || type,
    state: slotStateFor(type, docs),
  }))

  const total = rows.length
  const approved = rows.filter((r) => r.state === 'approved').length
  // Outstanding = anything not yet approved (missing or rejected re-upload).
  // Pending uploads are "in hand" so we do not nag for them, but rejected and
  // missing slots are exactly what the vendor still owes us.
  const outstanding = rows.filter((r) => r.state === 'missing' || r.state === 'rejected')

  async function handleRequest() {
    setBusy(true)
    setError(null)
    setSent(false)
    try {
      // The route expects { docs: string[] } of human-readable document names
      // (1 to 10). Pass the labels of the still-outstanding required docs so the
      // vendor sees exactly what to upload. Fall back to all required labels if
      // nothing is flagged outstanding (defensive: route 400s on an empty list).
      const docNames = (outstanding.length > 0 ? outstanding : rows).map((r) => r.label)
      const res = await fetch(`/api/admin/applications/${applicationId}/request-documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: docNames }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) {
        setError(j.error || `Failed (${res.status})`)
        return
      }
      setSent(true)
    } catch (e) {
      setError((e as Error).message || 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="font-serif text-lg text-[var(--text-primary)] flex items-center gap-2">
        Required documents
      </h3>

      <div className="space-y-1.5">
        {rows.map((row) => {
          const meta = STATE_META[row.state]
          return (
            <div
              key={row.type}
              className="flex items-center justify-between gap-3 border border-neutral-200 rounded-lg px-3 py-2.5"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="shrink-0">{meta.icon}</span>
                <span className="text-sm text-neutral-800 truncate">{row.label}</span>
              </div>
              <StatusPill tone={meta.tone} label={meta.label} />
            </div>
          )
        })}
      </div>

      <p className="text-xs text-neutral-500">
        {approved} of {total} required documents approved
      </p>

      <div className="flex flex-col gap-2">
        <button
          onClick={handleRequest}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 self-start rounded-md bg-[#cd2653] hover:bg-[#b01f45] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Request documents
        </button>
        {sent && <p className="text-xs text-emerald-600">Reminder sent.</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </div>
  )
}
