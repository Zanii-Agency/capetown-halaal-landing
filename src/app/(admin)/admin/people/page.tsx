import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, type StaffMember } from '@/lib/portal-state'
import { vendorInOwnerScope } from '@/lib/eft'
import { getOrders, type WCOrder } from '@/lib/woocommerce'
import { PeopleTable, type PersonRow } from '@/components/admin/people/PeopleTable'

export const dynamic = 'force-dynamic'

/**
 * Flat People register.
 *
 * One sortable table over every named human attending the festival:
 *   - buyers   (WooCommerce orders, Law 6 cycle filter via getOrders)
 *   - staff    (portal_state.staff[] embedded in vendor_applications.admin_notes)
 *   - vendors  (status='approved' rows in vendor_applications)
 *
 * The table component owns search + pagination on the client. We hydrate the
 * full list server-side because WC + vendor scans are too heavy to re-run on
 * every keystroke and Law 4 says read at request time.
 */
export default async function PeoplePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')

  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).single()
  if (!adminUser) redirect('/admin/login')

  // ---- Vendors + staff (one Supabase round-trip) ----
  const { data: vendors } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at')
    .eq('status', 'approved')

  const vendorRows: PersonRow[] = []
  const staffRows: PersonRow[] = []
  for (const v of vendors || []) {
    // The people register must not reveal EFT-lane vendors or their staff to the
    // festival owner. Master-lane vendors are still visible to the EFT admin.
    if (!vendorInOwnerScope(v.admin_notes as string | null, v.paid_at as string | null)) continue
    const vId = v.id as string
    const businessName = (v.business_name as string) || 'Vendor'
    vendorRows.push({
      key: `vendor:${vId}`,
      type: 'vendor',
      name: (v.contact_name as string) || businessName,
      phone: (v.phone as string) || null,
      email: (v.email as string) || null,
      reference: `App #${vId.slice(0, 8)}`,
      vendor_name: businessName,
      vendor_id: vId,
      order_id: null,
    })
    const portal = parsePortalState((v.admin_notes as string) || '')
    const staff = (portal.staff || []) as StaffMember[]
    for (const s of staff) {
      staffRows.push({
        key: `staff:${vId}:${s.id}`,
        type: 'staff',
        name: s.name,
        phone: s.phone || null,
        email: null,
        reference: s.wc_order_number ? `Badge #${s.wc_order_number}` : `Staff ${s.id.slice(0, 6)}`,
        vendor_name: businessName,
        vendor_id: vId,
        order_id: s.wc_order_id || null,
      })
    }
  }

  // ---- Buyers (WC orders, Law 6 cycle filter) ----
  let buyerRows: PersonRow[] = []
  try {
    const orders = await getOrders({ status: 'completed,processing' })
    buyerRows = orders.map((o: WCOrder) => {
      const firstName = o.billing?.first_name || ''
      const lastName = o.billing?.last_name || ''
      const fullName = `${firstName} ${lastName}`.trim() || (o.billing?.email || 'Buyer')
      return {
        key: `buyer:${o.id}`,
        type: 'buyer',
        name: fullName,
        phone: o.billing?.phone || null,
        email: o.billing?.email || null,
        reference: `Order #${o.id}`,
        vendor_name: null,
        vendor_id: null,
        order_id: o.id,
      } satisfies PersonRow
    })
  } catch (e) {
    console.error('[admin/people] WC orders fetch failed', e)
  }

  const rows: PersonRow[] = [...buyerRows, ...staffRows, ...vendorRows]

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto">
      <header className="mb-6">
        <p className="text-xs font-semibold text-[#cd2653] uppercase tracking-[0.2em]">Operations</p>
        <h1 className="text-3xl font-bold text-neutral-900 mt-1">People</h1>
        <p className="text-sm text-neutral-600 mt-2 max-w-2xl">
          Every named human at the festival. Buyers, staff badges, and vendors in one register.
          Click Verify to open the gate lookup with this person pre-loaded.
        </p>
      </header>
      <PeopleTable rows={rows} />
    </div>
  )
}
