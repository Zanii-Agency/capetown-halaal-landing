/**
 * GET /api/admin/documents/vendors
 *
 * Returns every vendor-uploaded document across all vendor_applications,
 * one row per DocRecord stored on the ⟦PORTAL:..⟧ marker in admin_notes.
 *
 * Admin-only. Mirrors the auth pattern from /api/admin/support-inbox/threads.
 *
 * Query params:
 *   - search: case-insensitive substring on business_name OR contact_name OR email
 *   - doc_type: filter to a specific type (halaal_cert, public_liability, etc)
 *   - status: pending | approved | rejected
 *   - limit: default 500 (every doc-row is small, this is a directory page)
 *
 * Each row carries enough context to render and to open the PDF via the
 * existing /api/admin/vendor-doc?path= signed-URL redirect. No new storage
 * surface, no anon path, no DDL.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, type DocRecord } from '@/lib/portal-state'
import { isEftAdmin, vendorInOwnerScope } from '@/lib/eft'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface VendorDocRow {
  application_id: string
  business_name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  application_status: string | null
  doc_type: string
  doc_name: string
  doc_status: DocRecord['status']
  uploaded_at: string
  storage_path: string
  note: string | null
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const restrict = !isEftAdmin(user.email ?? null)

  const url = new URL(req.url)
  const search = (url.searchParams.get('search') || '').trim().toLowerCase()
  const docType = (url.searchParams.get('doc_type') || '').trim()
  const status = (url.searchParams.get('status') || '').trim().toLowerCase()
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 1), 2000)

  // Pull every vendor application and explode docs server-side. The portal
  // marker is a base64 JSON blob on admin_notes (no separate table per the
  // DDL-locked Supabase constraint), so we cannot push the doc filter into
  // SQL. We DO scope on application_status to drop hard-rejected rows the
  // operator would never want to look at.
  const { data: apps, error } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, status, admin_notes, paid_at, contract_signed_at, contract_pdf_path')
    .order('updated_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows: VendorDocRow[] = []
  for (const app of apps || []) {
    const a = app as {
      id: string
      business_name: string
      contact_name: string | null
      email: string | null
      phone: string | null
      status: string | null
      admin_notes: string | null
      paid_at: string | null
      contract_signed_at: string | null
      contract_pdf_path: string | null
    }
    if (restrict && !vendorInOwnerScope(a.admin_notes, a.paid_at)) continue
    const state = parsePortalState(a.admin_notes)
    const docs = state.docs || []
    for (const d of docs) {
      rows.push({
        application_id: a.id,
        business_name: a.business_name,
        contact_name: a.contact_name,
        email: a.email,
        phone: a.phone,
        application_status: a.status,
        doc_type: d.type,
        doc_name: d.name,
        doc_status: d.status,
        uploaded_at: d.uploaded_at,
        storage_path: d.path,
        note: d.note ?? null,
      })
    }

    // Synthetic row for signed vendor contracts so they surface in the
    // directory next to compliance docs. The contract storage_path uses the
    // `contract:` prefix as a sentinel, so DocumentsClient routes the View
    // button to /api/admin/applications/<id>/contract/pdf instead of the
    // generic /api/admin/vendor-doc?path= path. No new bucket, no fork.
    if (a.contract_signed_at) {
      rows.push({
        application_id: a.id,
        business_name: a.business_name,
        contact_name: a.contact_name,
        email: a.email,
        phone: a.phone,
        application_status: a.status,
        doc_type: 'vendor_contract',
        doc_name: 'Vendor Contract 2026',
        doc_status: 'approved',
        uploaded_at: a.contract_signed_at,
        storage_path: `contract:${a.id}`,
        note: 'Signed via portal',
      })
    }
  }

  // Filter in-memory. Doc volumes are bounded by approved-vendor count (~120
  // for 2026 festival) x ~5 doc slots = under 1000 rows. Trivial.
  let filtered = rows
  if (docType) filtered = filtered.filter((r) => r.doc_type === docType)
  if (status) filtered = filtered.filter((r) => r.doc_status === status)
  if (search) {
    filtered = filtered.filter((r) => {
      const bn = r.business_name?.toLowerCase() || ''
      const cn = r.contact_name?.toLowerCase() || ''
      const em = r.email?.toLowerCase() || ''
      return bn.includes(search) || cn.includes(search) || em.includes(search)
    })
  }

  filtered.sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''))

  return NextResponse.json({
    rows: filtered.slice(0, limit),
    total: filtered.length,
  })
}
