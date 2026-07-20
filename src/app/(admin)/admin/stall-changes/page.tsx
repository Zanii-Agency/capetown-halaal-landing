import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { StallChangesClient } from './StallChangesClient'

export const dynamic = 'force-dynamic'

// Admin Stall Changes queue. The operator-facing half of the vendor stall-change
// flow: every pending request lands here with Approve / Reject. Approving moves
// the vendor to the requested tier and resolves the vendor's "pending" state.
//
// CTH-DOCTRINE alignment:
//  - Law 2 (vendor PII): server gate enforces an admin session before render;
//    the underlying /api/admin/stall-changes route re-checks role on every call.
//  - Law 8 (stall allocation): the request + status live on the admin_notes
//    portal-state marker, never a phantom stalls table.
export default async function StallChangesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')

  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, role').eq('id', user.id).maybeSingle()
  if (!adminUser) redirect('/admin/login')

  return <StallChangesClient />
}
