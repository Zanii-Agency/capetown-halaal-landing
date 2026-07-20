'use client'

import { History } from 'lucide-react'

// Chronological (newest first) audit timeline for the admin vendor profile.
// Renders every audit event with a humanised event_type, the note, the actor,
// and a formatted timestamp. Pure presentational: the caller passes events in
// already (the same AuditEvent shape Vendor360 hydrates from the audit table).

// Local copy of fmtDate, mirroring Vendor360's helper so this component is
// fully self-contained (no shared import to break).
function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

// Friendly labels for the common audit event_type values. Anything not in the
// map falls back to a humanised form (underscores -> spaces, Title Case).
const EVENT_LABELS: Record<string, string> = {
  payment_manual: 'Payment recorded',
  payment_proof_uploaded: 'Payment proof uploaded',
  vendor_amended: 'Vendor amended',
  vendor_approved: 'Vendor approved',
  vendor_rejected: 'Vendor rejected',
  stall_allocated: 'Stall allocated',
  stall_change_requested: 'Stall change requested',
  stall_change_approved: 'Stall change approved',
  stall_change_rejected: 'Stall change rejected',
  document_uploaded: 'Document uploaded',
  document_approved: 'Document approved',
  document_rejected: 'Document rejected',
  contract_signed: 'Contract signed',
  terms_accepted: 'Terms accepted',
  staff_added: 'Staff added',
  staff_revoked: 'Staff revoked',
  note_added: 'Note added',
  whatsapp_opt_in: 'WhatsApp opt-in',
}

function humanise(eventType: string): string {
  const mapped = EVENT_LABELS[eventType]
  if (mapped) return mapped
  return (eventType || '')
    .replace(/_/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Event'
}

export function VendorActivityLog({
  events,
}: {
  events: Array<{
    id: string
    event_type: string
    note: string | null
    created_at: string
    actor_email: string | null
  }>
}) {
  if (!events || events.length === 0) {
    return (
      <p className="text-sm text-neutral-500 flex items-center gap-2">
        <History className="w-3.5 h-3.5 text-neutral-400" /> No activity recorded yet.
      </p>
    )
  }

  // Newest first. Copy before sort so we never mutate the caller's array.
  const ordered = [...events].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )

  return (
    <div className="space-y-1">
      {ordered.map((e) => (
        <div
          key={e.id}
          className="border border-neutral-200 rounded-lg px-3 py-2.5 hover:bg-neutral-50 transition-colors"
        >
          <div className="flex items-baseline gap-3">
            <span className="shrink-0 text-xs text-neutral-400 tabular-nums w-28">
              {fmtDate(e.created_at)}
            </span>
            <span className="flex-1 text-sm font-medium text-neutral-800">
              {humanise(e.event_type)}
            </span>
            {e.actor_email && (
              <span className="shrink-0 text-xs text-neutral-400 truncate max-w-[40%]">
                {e.actor_email}
              </span>
            )}
          </div>
          {e.note && (
            <p className="mt-1 pl-[7.75rem] text-xs text-neutral-600 whitespace-pre-wrap break-words">
              {e.note}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
