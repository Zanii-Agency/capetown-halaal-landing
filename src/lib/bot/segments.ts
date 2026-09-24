// Resolve a named segment of recipients. Samreen's "give it to me in plain
// English" surface — she says "all approved unpaid" → this returns the rows.
// Used by both the /admin/outbox UI and the chat-driven email blast handler.

import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { vendorCommsInOwnerScope } from '@/lib/eft'
import { loadWalledContacts } from '@/lib/broadcast-audience'

// Canonical "paid" test for the CTH table. There is NO payment_status column
// here (verified against information_schema); the only real top-level payment
// column is paid_at, and the rest of the payment detail lives in the ⟦PORTAL⟧
// marker on admin_notes. So paid = paid_at set OR marker payment.status==='paid'.
// paid_at also covers waived vendors (confirm.ts stamps paid_at on a waiver).
function isRowPaid(r: { paid_at: string | null; admin_notes: string | null }): boolean {
  if (r.paid_at) return true
  return parsePortalState(r.admin_notes).payment?.status === 'paid'
}

export type SegmentKey =
  | 'pending'
  | 'approved'
  | 'approved_unpaid'
  | 'approved_paid'
  | 'rejected'
  | 'info_requested'
  | 'ticket_buyers'

export const SEGMENT_LABELS: Record<SegmentKey, string> = {
  pending: 'Pending vendor applications (under review)',
  approved: 'Approved vendors (all)',
  approved_unpaid: 'Approved vendors who have NOT paid yet',
  approved_paid: 'Approved vendors who HAVE paid',
  rejected: 'Rejected vendor applications',
  info_requested: 'Vendors we asked for more information from',
  ticket_buyers: 'Everyone who has bought tickets',
}

export interface Recipient {
  email: string
  name: string | null
  business_name?: string | null
  application_id?: string
}

// Natural-language phrase → segment key. Tiny matcher first; LLM fallback for
// ambiguous phrasing happens in the bot handler.
export function matchSegment(phrase: string): SegmentKey | null {
  const p = (phrase || '').toLowerCase()
  if (/\bticket\s*buyer|ticket\s*holder|attendee|bought\s+(a\s+)?ticket/.test(p)) return 'ticket_buyers'
  if (/\binfo[\s_]?request|more\s+info|needed\s+(more\s+)?info/.test(p)) return 'info_requested'
  if (/\b(reject|declin|not\s+approv|unsuccessful)/.test(p)) return 'rejected'
  if (/\b(approv|accept)/.test(p)) {
    if (/\b(unpaid|not\s+paid|haven.?t\s+paid|outstanding|pending\s+payment|owing|due)/.test(p)) return 'approved_unpaid'
    if (/\b(paid|settled)/.test(p)) return 'approved_paid'
    return 'approved'
  }
  if (/\b(pending|under\s+review|awaiting)/.test(p)) return 'pending'
  return null
}

// ownerView: the festival owner (Samreen) asked. Anyone outside her world (a
// master-lane payer, by ROW or by PERSON across twin rows) is dropped, and if
// the wall cannot be loaded the segment is empty: fail closed, never open.
export async function resolveSegment(key: SegmentKey, opts: { ownerView?: boolean } = {}): Promise<Recipient[]> {
  const rows = await resolveSegmentRaw(key)
  if (!opts.ownerView) return rows.map(({ owner: _o, ...r }) => r)
  const wall = await loadWalledContacts()
  if (!wall) throw new Error('owner wall unavailable, refusing segment')
  return rows.filter((r) => r.owner && !wall.blocks(r.phone, r.email)).map(({ owner: _o, ...r }) => r)
}

type RawRecipient = Recipient & { owner: boolean; phone?: string | null }

async function resolveSegmentRaw(key: SegmentKey): Promise<RawRecipient[]> {
  const db = createAdminClient()

  if (key === 'ticket_buyers') {
    const { data } = await db
      .from('ticket_buyers')
      .select('email, name')
      .limit(5000)
    return (data || [])
      .filter((r) => r.email)
      .map((r) => ({
        email: r.email as string,
        name: r.name || null,
        owner: true,
      }))
  }

  // Vendor-application segments
  const baseStatus = key === 'approved_unpaid' || key === 'approved_paid' ? 'approved' : key
  const { data } = await db
    .from('vendor_applications')
    .select('id, email, phone, business_name, contact_name, admin_notes, paid_at')
    .eq('status', baseStatus)
    .limit(5000)
  let rows = (data || []) as Array<{
    id: string
    email: string | null
    phone: string | null
    business_name: string | null
    contact_name: string | null
    admin_notes: string | null
    paid_at: string | null
  }>

  // approved_paid and approved_unpaid are exact complements over the approved
  // set, partitioned on isRowPaid (see helper above).
  if (key === 'approved_unpaid') {
    rows = rows.filter((r) => !isRowPaid(r))
  }
  if (key === 'approved_paid') {
    rows = rows.filter((r) => isRowPaid(r))
  }

  return rows
    .filter((r) => r.email)
    .map((r) => ({
      email: r.email as string,
      name: r.contact_name,
      business_name: r.business_name,
      application_id: r.id,
      phone: r.phone,
      owner: vendorCommsInOwnerScope(r.admin_notes, r.paid_at),
    }))
}

export async function segmentCount(key: SegmentKey, opts: { ownerView?: boolean } = {}): Promise<number> {
  const rows = await resolveSegment(key, opts)
  return rows.length
}
