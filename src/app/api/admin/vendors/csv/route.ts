/**
 * GET /api/admin/vendors/csv?ids=<csv>&status=<filter>
 *
 * Streams a CSV of approved vendors with the columns Samreen uses for ops
 * planning. Defaults to all approved vendors when no ids are supplied.
 *
 * Columns: business_name, contact_name, phone, email, sector, description,
 * status, stall_code, payment_status, contract_signed_at.
 *
 * `description` is the vendor's own "Business or menu description" captured on
 * the apply form (vendor_applications.business_description).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function escapeCsv(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in. Please log in again.' }, { status: 401 })

  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, role, email').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'Your account is not an admin user.' }, { status: 403 })
  // H5: PII export requires owner/operator. Cap row count + audit log.
  const role = ((adminUser as { role?: string }).role || 'operator').toLowerCase()
  if (!['owner', 'operator'].includes(role)) {
    return NextResponse.json({ error: `Your role (${role}) cannot export vendor data. Ask the owner for owner/operator access.` }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const idsParam = sp.get('ids')
  const ids = idsParam ? idsParam.split(',').map((x) => x.trim()).filter(Boolean) : null
  const status = sp.get('status') || 'approved'

  const CSV_MAX_ROWS = 1000
  let q = db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, product_categories, business_description, status, admin_notes, contract_signed_at')
    .order('business_name', { ascending: true })
    .limit(CSV_MAX_ROWS)
  if (ids && ids.length) q = q.in('id', ids)
  else if (status && status !== 'all') q = q.eq('status', status)

  const { data, error } = await q
  if (error) {
    console.error('[vendors/csv] query failed:', error.message)
    return NextResponse.json({ error: `Could not read vendors: ${error.message}` }, { status: 500 })
  }

  // H5: audit log every export so we can trace PII flows. We anchor the
  // event on the first exported vendor's application_id (the audit table FK
  // requires a non-null application_id), and stash the full id list +
  // filter in before_value. site_events would be cleaner but the existing
  // operator-facing audit UI reads vendor_application_events only.
  try {
    const actorEmail = ((adminUser as { email?: string | null }).email) ?? user.email ?? null
    const rowIds = ((data as Array<{ id: string }> | null) || []).map((r) => r.id).slice(0, CSV_MAX_ROWS)
    if (rowIds.length > 0) {
      await db.from('vendor_application_events').insert({
        application_id: rowIds[0],
        event_type: 'csv_export',
        before_value: {
          row_count: rowIds.length,
          filter: status,
          ids_filter: ids ? ids.slice(0, 50) : null,
          exported_ids_sample: rowIds.slice(0, 50),
        },
        after_value: null,
        actor_email: actorEmail,
        actor_role: role,
        note: `CSV export of ${rowIds.length} vendors by ${actorEmail || 'unknown'}`,
      })
    }
  } catch (e) {
    console.warn('[vendors/csv] audit insert failed:', (e as Error).message)
  }

  const headers = [
    'business_name', 'contact_name', 'phone', 'email', 'sector', 'description',
    'status', 'stall_code', 'payment_status', 'contract_signed_at',
  ]
  const lines: string[] = [headers.join(',')]
  for (const row of (data || []) as Array<{
    business_name: string | null
    contact_name: string | null
    email: string | null
    phone: string | null
    product_categories: string[] | null
    business_description: string | null
    status: string | null
    admin_notes: string | null
    contract_signed_at: string | null
  }>) {
    const portal = parsePortalState(row.admin_notes || '')
    const { stall } = parseAllocation(row.admin_notes || '')
    const sector = row.product_categories?.[0] || ''
    const paymentStatus = portal.payment?.status || 'none'
    lines.push([
      escapeCsv(row.business_name),
      escapeCsv(row.contact_name),
      escapeCsv(row.phone),
      escapeCsv(row.email),
      escapeCsv(sector),
      escapeCsv(row.business_description),
      escapeCsv(row.status),
      escapeCsv(stall),
      escapeCsv(paymentStatus),
      escapeCsv(row.contract_signed_at),
    ].join(','))
  }

  const filename = `vendors-${new Date().toISOString().slice(0, 10)}.csv`
  return new NextResponse(lines.join('\n'), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}
