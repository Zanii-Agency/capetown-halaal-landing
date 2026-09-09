// The frozen "new vendors" cohort: never-traded vendors hand-flipped onto master
// EFT, tagged ⟦NEWVENDOR⟧. Master-only tracking list for /admin/new-vendors. The
// tag is stripped from the festival owner by COVERT_NOTE_RE, and every vendor here
// is already on the master lane (⟦EFT⟧), so nothing about this cohort reaches her.
import { createAdminClient } from '@/lib/supabase/admin'
import { hasNewVendorMarker } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { vendorBill } from '@/lib/payments/vendor-bill'

export type NewVendorStatus = 'Paid' | 'Collected' | 'Proof uploaded' | 'Opened EFT' | 'Not started'

export interface NewVendorRow {
  id: string
  business_name: string
  phone: string | null
  email: string | null
  status: NewVendorStatus
  owed: number
  billed: number
  applied: string | null
}

// Sort so the ones needing action float up: not-started first, paid last.
const ORDER: Record<NewVendorStatus, number> = {
  'Not started': 0, 'Opened EFT': 1, 'Proof uploaded': 2, 'Collected': 3, 'Paid': 4,
}

export async function loadNewVendors(): Promise<{ rows: NewVendorRow[]; totalOwed: number; paidCount: number }> {
  const db = createAdminClient()
  const { data } = await db
    .from('vendor_applications')
    .select('id, business_name, phone, email, admin_notes, paid_at, preferred_booth_tier, special_requirements, created_at, is_duplicate')
    .eq('status', 'approved')

  const rows: NewVendorRow[] = []
  for (const v of data || []) {
    if ((v as { is_duplicate?: boolean }).is_duplicate) continue
    if (!hasNewVendorMarker(v.admin_notes as string | null)) continue
    const p = parsePortalState(v.admin_notes as string).payment
    let status: NewVendorStatus = 'Not started'
    if (v.paid_at || p?.status === 'paid') status = 'Paid'
    else if (p?.status === 'collected' || p?.eft_collected_at) status = 'Collected'
    else if (p?.eft_submitted_at) status = 'Proof uploaded'
    else if (p?.eft_revealed_at) status = 'Opened EFT'
    let owed = 0, billed = 0
    try {
      const b = vendorBill({
        id: v.id as string,
        preferred_booth_tier: v.preferred_booth_tier as string,
        special_requirements: v.special_requirements,
        admin_notes: v.admin_notes as string,
        paid_at: v.paid_at as string | null,
      })
      owed = b.owing; billed = b.liveTotal
    } catch { /* unpriceable, leave 0 */ }
    rows.push({
      id: v.id as string,
      business_name: (v.business_name as string) || 'Unnamed',
      phone: (v.phone as string) || null,
      email: (v.email as string) || null,
      status, owed, billed,
      applied: (v.created_at as string) || null,
    })
  }

  rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.business_name.localeCompare(b.business_name))
  return {
    rows,
    totalOwed: rows.reduce((s, r) => s + r.owed, 0),
    paidCount: rows.filter((r) => r.status === 'Paid').length,
  }
}
