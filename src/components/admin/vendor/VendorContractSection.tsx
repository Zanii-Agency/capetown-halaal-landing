'use client'

import { useState } from 'react'
import { FileText, ExternalLink, Loader2, Send, Check } from 'lucide-react'
import { StatusPill } from '@/components/chrome/StatusPill'

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

// Presentational Contract section for the admin vendor profile. Reads the
// contract state straight off the vendor row (contract_signed_at /
// contract_pdf_path / contract_version) and exposes two operator actions:
//
//   - View contract: opens the admin contract PDF route in a new tab. That
//     route (GET /api/admin/applications/[id]/contract/pdf) is requireOperator
//     -gated, 404s when there is no signed contract on file, and streams the
//     PDF same-origin. We only show the link when there is something to view
//     (a signed_at stamp or a contract_pdf_path).
//
//   - Resend contract: POSTs to /api/admin/vendors/[id]/resend-contract (the
//     [id] path param is the application id). No body required; the route
//     re-renders the contract_sign_reminder template to the vendor's email of
//     record. Best-effort, with an inline busy spinner + Sent / error state.
export function VendorContractSection({
  applicationId,
  vendor,
}: {
  applicationId: string
  vendor: Record<string, unknown>
}) {
  const signedAt = vendor.contract_signed_at ? String(vendor.contract_signed_at) : null
  const pdfPath = vendor.contract_pdf_path ? String(vendor.contract_pdf_path) : null
  const version = vendor.contract_version ? String(vendor.contract_version) : null
  const hasContract = Boolean(signedAt || pdfPath)
  const pdfUrl = `/api/admin/applications/${applicationId}/contract/pdf`

  const [resendBusy, setResendBusy] = useState(false)
  const [resendOk, setResendOk] = useState(false)
  const [resendErr, setResendErr] = useState<string | null>(null)

  async function handleResend() {
    setResendBusy(true)
    setResendOk(false)
    setResendErr(null)
    try {
      const r = await fetch(`/api/admin/vendors/${applicationId}/resend-contract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setResendErr(j.error || `Failed (${r.status})`)
        return
      }
      setResendOk(true)
    } catch (e) {
      setResendErr((e as Error).message)
    } finally {
      setResendBusy(false)
    }
  }

  return (
    <section className="bg-[var(--bg-surface)] rounded-lg border border-[var(--border)] shadow-sm p-5">
      <h3 className="font-serif text-lg text-[var(--text-primary)] mb-4 flex items-center gap-2">
        <FileText className="w-4 h-4" /> Contract
      </h3>

      <div className="flex flex-wrap items-center gap-3">
        {signedAt ? (
          <>
            <StatusPill tone="success" label="Signed" />
            <span className="text-sm text-neutral-700">{fmtDate(signedAt)}</span>
            {version && (
              <span className="font-mono text-xs text-neutral-500 bg-neutral-50 px-2 py-0.5 rounded border border-neutral-200">
                {version}
              </span>
            )}
          </>
        ) : (
          <StatusPill tone="warn" label="Not signed yet" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 mt-4">
        {hasContract ? (
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:underline"
          >
            <ExternalLink className="w-4 h-4" /> View contract
          </a>
        ) : (
          <span className="text-sm text-neutral-500">No contract generated yet</span>
        )}

        <button
          onClick={handleResend}
          disabled={resendBusy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-[#cd2653] text-white hover:bg-[#b01f45] disabled:opacity-60"
        >
          {resendBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Resend contract
        </button>

        {resendOk && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
            <Check className="w-3.5 h-3.5" /> Sent
          </span>
        )}
        {resendErr && <span className="text-xs text-red-600">{resendErr}</span>}
      </div>
    </section>
  )
}
