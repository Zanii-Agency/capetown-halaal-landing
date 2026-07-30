import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { isEftAdmin, vendorInOwnerScope } from '@/lib/eft'

// GET /api/admin/manifest -> gate manifest CSV (names + IDs + vehicles + stall).
// Auth: admin session OR `Authorization: Bearer ${CRON_SECRET}` header.
export async function GET(request: NextRequest) {
  // Header-only Bearer (constant-time). `?secret=` query branch removed
  // because it leaks into access logs / browser history / referrers.
  let authorized = verifyCronAuth(request.headers.get('authorization'))
  let viewerEmail: string | null = null
  let isCron = authorized
  if (!authorized) {
    try {
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const admin = createAdminClient()
        const { data: adminUser } = await admin.from('admin_users').select().eq('id', user.id).single()
        if (adminUser) {
          authorized = true
          viewerEmail = user.email ?? null
        }
      }
    } catch { /* fall through */ }
  }
  if (!authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const restrict = !!viewerEmail && !isEftAdmin(viewerEmail)

  const admin = createAdminClient()
  const { data: apps } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, status, admin_notes, paid_at')
    .order('business_name')

  const esc = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const rows = [['Business', 'Stall', 'Staff name', 'Vehicle reg', 'Application status'].map(esc).join(',')]

  for (const a of apps || []) {
    if (restrict && !vendorInOwnerScope(a.admin_notes as string | null, a.paid_at as string | null)) continue
    const { stall } = parseAllocation(a.admin_notes as string)
    const state = parsePortalState(a.admin_notes as string)
    for (const m of state.staff || []) {
      rows.push([a.business_name, stall || '', m.name, m.vehicle_reg || '', a.status].map(esc).join(','))
    }
  }

  const csv = rows.join('\n')
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="youngsfield-gate-manifest-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
