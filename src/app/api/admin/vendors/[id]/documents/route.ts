/**
 * POST /api/admin/vendors/[id]/documents
 *
 * Operator uploads a compliance document ON BEHALF of a vendor (2026-10-07,
 * Abdusamee: vendors send docs to the team directly). Same direct-to-storage
 * flow as the vendor portal (up to 10MB):
 *   { action:'sign', doc_type, name }          -> { path, token }
 *   { action:'commit', doc_type, path, name }  -> { ok, document }
 * Recorded as APPROVED (the team already holds and has seen the original).
 * No vendor notification, no owner fanout. Ledgered.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { laneScopeFor } from '@/lib/inbox-lane'
import { recordAdminAction } from '@/lib/zanii-ledger'
import { DOC_TYPES, signDocUpload, commitDocUpload } from '@/lib/vendor-doc-upload'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  const scope = await laneScopeFor(gate.user.email)
  if (scope.blocksApplicationId(id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const b = await req.json().catch(() => ({}))
  const docType = String(b.doc_type || '')
  const name = String(b.name || '')
  if (!DOC_TYPES.includes(docType)) return NextResponse.json({ error: 'Invalid document type' }, { status: 400 })

  if (b.action === 'sign') {
    try { return NextResponse.json(await signDocUpload(id, docType, name)) }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
  }
  if (b.action !== 'commit') return NextResponse.json({ error: 'Invalid action' }, { status: 400 })

  const path = String(b.path || '')
  const record = await commitDocUpload({
    applicationId: id, docType, path, name, status: 'approved',
    note: `Uploaded by ${gate.adminUser.email || 'admin'}`,
  })
  if (!record) return NextResponse.json({ error: 'Upload not found or over 10MB' }, { status: 400 })

  await recordAdminAction({
    actor: { email: gate.adminUser.email, role: gate.role },
    action: 'document_uploaded_for_vendor',
    vendorId: id,
    payload: { doc_type: docType, path, name },
  })
  return NextResponse.json({ ok: true, document: record })
}
