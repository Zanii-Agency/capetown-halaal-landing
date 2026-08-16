import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseAllocation, tierLabel } from '@/lib/stalls'
import { parsePortalState } from '@/lib/portal-state'
import { rosterPaymentStatus } from '@/lib/eft'
import { parseVendorExtras } from '@/lib/vendor-extras'
import { AdminPage } from '@/components/admin/AdminPage'
import { VendorsList, type VendorRow } from '@/components/admin/vendors/VendorsList'

export const dynamic = 'force-dynamic'

// Approved-vendor hub. Taona 2026-08-02: the festival owner sees the SAME list
// as the master — ALL approved vendors plus withdrawn ones (stored as
// status='rejected' + the portal-state withdrawn marker, Law 8). The owner-scope
// filter that used to live here was a comms predicate glued onto an operational
// list, and it left her at "67 approved" while Applications said 167.
//
// THE MASK IS METHOD-AWARE. rosterPaymentStatus collapses every master-lane
// state to 'none' for her: not only 'collected' but an EFT/manual settlement
// stamped status:'paid' (visiblePaymentStatus missed those, so Amc cookware and
// three others read 'paid' to her until 2026-08-11). Only a Yoco-reconciled
// payment (Y&K, Farfashions, Vanilla Cream) reads as paid. The list is global;
// the EFT truth stays hers never.
export default async function VendorsListPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')

  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).single()
  if (!adminUser) redirect('/admin/login')

  const { data: apps } = await admin
    .from('vendor_applications')
    .select(
      'id, business_name, contact_name, email, phone, product_categories, preferred_booth_tier, special_requirements, admin_notes, paid_at, contract_signed_at, contract_pdf_path, docs_complete_at, created_at, status, is_duplicate'
    )
    .in('status', ['approved', 'rejected'])
    .order('business_name', { ascending: true })

  const rows: VendorRow[] = (apps || [])
    .filter((a) => {
      if (a.is_duplicate) return false // merged duplicate (applications/merge)
      if (a.status === 'approved') return true
      // status='rejected' doubles as withdrawn (CHECK constraint, Law 8). Keep
      // only the marker-carriers; genuine rejections never render here.
      return !!parsePortalState((a.admin_notes as string) || '').withdrawn
    })
    .map((a) => {
      const notes = (a.admin_notes as string) || ''
      const { stall, status: stallStatus } = parseAllocation(notes)
      const portal = parsePortalState(notes)
      const paymentStatus = rosterPaymentStatus(notes, a.paid_at as string | null, user.email)
      const paymentAmount = portal.payment?.amount || null
      const docsCount = (portal.docs || []).length
      const contractSigned = !!(a.contract_signed_at || a.contract_pdf_path)
      const extras = parseVendorExtras(a.special_requirements as string | null)
      const withdrawn = !!portal.withdrawn
      // Prefer the raw stall-type label the vendor chose; fall back to the tier slug label.
      const stallType = extras.stallType || tierLabel(a.preferred_booth_tier as string)

      const blockers: string[] = []
      if (withdrawn) blockers.push('Withdrawn')
      if (paymentStatus !== 'paid' && paymentStatus !== 'waived') blockers.push('Fee unpaid')
      if (!contractSigned) blockers.push('Contract unsigned')
      if (docsCount === 0) blockers.push('No docs')
      if (!stall) blockers.push('No stall allocated')

      return {
        id: a.id as string,
        business_name: (a.business_name as string) || 'Unnamed vendor',
        contact_name: (a.contact_name as string) || null,
        email: (a.email as string) || null,
        phone: (a.phone as string) || null,
        categories: (a.product_categories as string[]) || [],
        tier_label: tierLabel(a.preferred_booth_tier as string),
        stall_type: stallType,
        appliances: extras.appliances,
        appliance_details: extras.applianceDetails,
        uses_gas: extras.usesGas,
        stall: stall,
        stall_status: stall ? stallStatus : null,
        payment_status: paymentStatus,
        payment_amount: paymentAmount,
        docs_count: docsCount,
        contract_signed: contractSigned,
        docs_complete_at: (a.docs_complete_at as string) || null,
        contract_signed_at: (a.contract_signed_at as string) || null,
        blockers,
        created_at: (a.created_at as string) || '',
        withdrawn,
      }
    })

  if (rows.length === 0) {
    return (
      <AdminPage title="Approved vendors" caption="VENDORS">
        <div className="border border-dashed border-neutral-300 rounded-xl p-10 text-center text-neutral-500 text-sm">
          No approved vendors yet.
          <div className="mt-3">
            <Link href="/admin/applications" className="text-[#cd2653] hover:underline font-medium">
              Go to applications →
            </Link>
          </div>
        </div>
      </AdminPage>
    )
  }

  // VendorsList carries its own page header + padding, so it renders directly
  // (wrapping it in AdminPage would double the "Approved vendors / VENDORS" header).
  return <VendorsList rows={rows} />
}
