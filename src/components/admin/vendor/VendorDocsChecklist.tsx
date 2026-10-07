'use client'

// Required-documents checklist for the admin vendor profile. Shows, for each
// required doc slot, whether the vendor has it (approved / awaiting review /
// rejected) or is still missing it, plus a one-click "Request documents" action
// that fires the Meta-approved WhatsApp template + matching email for the docs
// that are still outstanding. Pure presentational + one fetch (best-effort).
//
// No em-dashes anywhere vendor-facing (CTH-DOCTRINE Law 7).

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Clock, X, AlertCircle, Loader2, Send, Plus, Upload } from 'lucide-react'
import { uploadDocDirect } from '@/lib/client/prepare-upload'
import { StatusPill } from '@/components/chrome/StatusPill'
import { REQUIRED_DOC_TYPES, REQUIRED_DOC_LABELS } from '@/app/(admin)/admin/vendors/[id]/doc-types'
import type { DocRecord } from '@/lib/portal-state'
import { EXTRA_DOC_TYPES } from '@/lib/exhibitor/required-docs'

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
  extraRequired = [],
}: {
  applicationId: string
  docs: import('@/lib/portal-state').DocRecord[]
  /** Admin-added ⟦REQDOC:..⟧ types for this vendor (removable). */
  extraRequired?: string[]
}) {
  const router = useRouter()
  const [addType, setAddType] = useState('')
  const [reqBusy, setReqBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [upBusy, setUpBusy] = useState<string | null>(null)
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})

  // Upload a doc the team already holds, on the vendor's behalf (recorded as
  // approved, no vendor message). Direct to storage, up to 10MB.
  async function uploadFor(type: string, file: File) {
    setUpBusy(type)
    setError(null)
    try {
      await uploadDocDirect(`/api/admin/vendors/${applicationId}/documents`, type, file)
      router.refresh()
    } catch (e) {
      setError((e as Error).message || 'Upload failed')
    } finally {
      setUpBusy(null)
    }
  }

  const types = Array.from(new Set<string>([...REQUIRED_DOC_TYPES, ...extraRequired]))
  const rows = types.map((type) => ({
    type,
    extra: extraRequired.includes(type) && !(REQUIRED_DOC_TYPES as readonly string[]).includes(type),
    label: REQUIRED_DOC_LABELS[type] || type,
    state: slotStateFor(type, docs),
  }))

  const total = rows.length
  const approved = rows.filter((r) => r.state === 'approved').length
  // Outstanding = anything not yet approved (missing or rejected re-upload).
  // Pending uploads are "in hand" so we do not nag for them, but rejected and
  // missing slots are exactly what the vendor still owes us.
  const outstanding = rows.filter((r) => r.state === 'missing' || r.state === 'rejected')

  // Add or remove a per-vendor required doc (⟦REQDOC:..⟧ marker). No send.
  async function toggleRequired(type: string, on: boolean) {
    if (!type) return
    setReqBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/vendors/${applicationId}/required-docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, on }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) { setError(j.error || `Failed (${res.status})`); return }
      setAddType('')
      router.refresh()
    } catch (e) {
      setError((e as Error).message || 'Update failed')
    } finally {
      setReqBusy(false)
    }
  }

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
              <div className="flex items-center gap-2 shrink-0">
                <StatusPill tone={meta.tone} label={meta.label} />
                <input
                  ref={(el) => { inputs.current[row.type] = el }}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadFor(row.type, f) }}
                />
                <button
                  onClick={() => inputs.current[row.type]?.click()}
                  disabled={upBusy === row.type}
                  title="Upload this document for the vendor"
                  className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50"
                >
                  {upBusy === row.type ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  {row.state === 'missing' ? 'Upload' : 'Replace'}
                </button>
                {row.extra && (
                  <button
                    onClick={() => toggleRequired(row.type, false)}
                    disabled={reqBusy}
                    title="Remove from this vendor's required list"
                    className="text-neutral-400 hover:text-red-600 disabled:opacity-50"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2">
        <select
          value={addType}
          onChange={(e) => setAddType(e.target.value)}
          className="rounded-md border border-neutral-200 px-2 py-1.5 text-sm"
        >
          <option value="">Add a required document...</option>
          {EXTRA_DOC_TYPES.filter((t) => !types.includes(t)).map((t) => (
            <option key={t} value={t}>{REQUIRED_DOC_LABELS[t] || t}</option>
          ))}
        </select>
        <button
          onClick={() => toggleRequired(addType, true)}
          disabled={!addType || reqBusy}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
        >
          {reqBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add
        </button>
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
