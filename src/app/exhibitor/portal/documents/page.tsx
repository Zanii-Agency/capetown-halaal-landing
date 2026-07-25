import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { createAdminClient } from '@/lib/supabase/admin'
import { paymentReference } from '@/lib/payments'
import DocumentsManager, { type DocView } from '@/components/exhibitor/DocumentsManager'
import GeneratedDocsPanel, { type StaffBadgeRef } from '@/components/exhibitor/GeneratedDocsPanel'
import { PageShell, PageHeader } from '@/components/chrome/PageChrome'
import { requirePaid } from '@/lib/exhibitor-paygate'
import MiniTaskStrip from '@/components/exhibitor/MiniTaskStrip'

export const dynamic = 'force-dynamic'

export default async function DocumentsPage() {
  await requirePaid()
  const ctx = await getExhibitorContext()
  const app = (ctx?.application || {}) as Record<string, unknown>
  const state = parsePortalState((app.admin_notes as string) || null)
  const docs = state.docs || []

  // Legacy + seed rows may carry doc records without a `path` field (e.g. the
  // Demo Halal Kitchen fixture stamped status=approved with no storage object).
  // The Supabase storage SDK throws when path is null/undefined, which used to
  // surface as a hard 500 for the vendor (digest 3115685589). We null-guard
  // here so the page renders, with the URL simply nulled out for those rows.
  const admin = createAdminClient()
  const views: DocView[] = await Promise.all(
    docs.map(async (d) => {
      let url: string | null = null
      if (d.path && typeof d.path === 'string' && d.path.trim().length > 0) {
        try {
          const { data } = await admin.storage.from('vendor-docs').createSignedUrl(d.path, 3600)
          url = data?.signedUrl || null
        } catch {
          url = null
        }
      }
      return { type: d.type, name: d.name, status: d.status, uploaded_at: d.uploaded_at, url, note: d.note }
    })
  )

  // Generated documents (festival side). 'collected' (EFT interim) shows as paid
  // to the vendor, same as the invoice/payments pages.
  const rawInvoiceStatus = state.payment?.status || 'none'
  const invoiceStatus = rawInvoiceStatus === 'collected' ? 'paid' : rawInvoiceStatus
  const invoiceRef = state.payment?.reference || paymentReference((app.id as string) || '')
  const contractSigned = Boolean(app.contract_signed_at)
  const staffBadges: StaffBadgeRef[] = (state.staff || []).map((s) => ({
    name: s.name,
    role: s.role || 'staff',
    wc_order_id: s.wc_order_id,
    fooevents_ticket_id: s.fooevents_ticket_id,
  }))

  return (
    <PageShell>
      <MiniTaskStrip activeKey="documents" />
      <PageHeader
        kicker="Documents"
        title="Your festival paperwork"
        subtitle="Everything we generated for you, and everything you uploaded for us. Two sides of the same folder."
      />

      <div className="max-w-3xl space-y-10">
        {/* Section 1: documents WE generated for the vendor. */}
        <section>
          <h2 className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#1B1A17]/55 mb-3">
            From the organisers
          </h2>
          <GeneratedDocsPanel
            invoiceStatus={invoiceStatus}
            invoiceRef={invoiceRef}
            contractSigned={contractSigned}
            staffBadges={staffBadges}
          />
        </section>

        {/* Section 2: documents the vendor uploaded. */}
        <section>
          <h2 className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#1B1A17]/55 mb-3">
            Compliance documents you upload
          </h2>
          <DocumentsManager docs={views} />
        </section>
      </div>
    </PageShell>
  )
}
