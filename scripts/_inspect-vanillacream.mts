// Read-only: dump Vanilla Cream's payment/portal state to decide the settle path.
import { createAdminClient } from '../src/lib/supabase/admin'
import { parsePortalState } from '../src/lib/portal-state'
import { vendorInOwnerScope, hasEftMarker } from '../src/lib/eft'

async function main() {
  const db = createAdminClient()
  const { data, error } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, status, admin_notes, paid_at, reviewed_at')
    .ilike('business_name', '%Vanilla%')
  if (error) { console.error('QUERY FAILED:', error.message); process.exit(1) }
  for (const app of data || []) {
    const st = parsePortalState(app.admin_notes) as unknown as Record<string, unknown>
    console.log('---')
    console.log('id           :', app.id)
    console.log('business     :', app.business_name)
    console.log('contact      :', app.contact_name, '|', app.email, '|', app.phone)
    console.log('status       :', app.status, '| paid_at:', app.paid_at)
    console.log('payment      :', JSON.stringify(st.payment || null, null, 2))
    console.log('stage        :', st.stage)
    console.log('hasEftMarker :', hasEftMarker(app.admin_notes))
    console.log('ownerScope   :', vendorInOwnerScope(app.admin_notes, app.paid_at))
    const notes = String(app.admin_notes || '')
    console.log('markers      :', (notes.match(/⟦[A-Z]+[^⟧]*⟧/g) || []).map(m => m.length > 60 ? m.slice(0, 60) + '…' : m).join(' '))
  }
  console.log(`\n${data?.length ?? 0} row(s) matched '%Vanilla%'`)
}

main().catch((e) => { console.error(e); process.exit(1) })
