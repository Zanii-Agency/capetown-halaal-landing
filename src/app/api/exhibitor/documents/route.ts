import { NextRequest, NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, parsePortalState, type DocRecord } from '@/lib/portal-state'

const BUCKET = 'vendor-docs'
// Canonical doc-type keys. Must match portal.docs[].type and the admin
// required-set in doc-action/route.ts + admin/vendors/[id]/doc-types.ts.
// `halaal_cert` (two a's) is the canonical spelling the portal writes.
// `gas_cert` is offered by DocumentsManager (conditional on gas use) and
// MUST be accepted here or every gas upload 400s.
const ALLOWED = ['halaal_cert', 'health_permit', 'gas_cert', 'fire_safety', 'public_liability', 'electrical_coc', 'contract', 'indemnity', 'other']
const MAX_BYTES = 10 * 1024 * 1024 // 10MB

// GET: list the signed-in vendor's documents with short-lived signed view URLs.
export async function GET() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const state = parsePortalState(ctx.application.admin_notes as string)
  const docs = state.docs || []
  const admin = createAdminClient()
  // Legacy/seed rows without `path` would throw inside the Supabase SDK.
  // Null-guard so the list still renders for the rest of the docs.
  const withUrls = await Promise.all(
    docs.map(async (d) => {
      let url: string | null = null
      if (d.path && typeof d.path === 'string' && d.path.trim().length > 0) {
        try {
          const { data } = await admin.storage.from(BUCKET).createSignedUrl(d.path, 3600)
          url = data?.signedUrl || null
        } catch { url = null }
      }
      return { ...d, url }
    })
  )
  return NextResponse.json({ docs: withUrls })
}

// POST: upload one document (multipart: file + doc_type) for the signed-in vendor.
export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const applicationId = ctx.application.id as string

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  const docType = String(form?.get('doc_type') || '')
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  if (!ALLOWED.includes(docType)) return NextResponse.json({ error: 'Invalid document type' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 })

  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
  const path = `${applicationId}/${docType}-${Date.now()}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  const admin = createAdminClient()
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buffer, {
    contentType: file.type || 'application/octet-stream',
    upsert: true,
  })
  if (upErr) {
    console.error('[documents] upload failed:', upErr.message)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }

  const record: DocRecord = {
    type: docType,
    path,
    name: file.name,
    status: 'pending',
    uploaded_at: new Date().toISOString(),
  }
  // Replace any prior doc of the same type, then add the new one.
  await updatePortalState(applicationId, (s) => ({
    ...s,
    docs: [...(s.docs || []).filter((d) => d.type !== docType), record],
  }))

  // Activity timeline + admin notification fanout. site_events drives both
  // the admin inbox feed and the vendor profile Activity tab.
  try {
    await admin.from('site_events').insert({
      session_id: `vendor-${applicationId}`,
      event_type: 'vendor_doc_uploaded',
      path: '/exhibitor/portal/documents',
      metadata: {
        vendor_application_id: applicationId,
        doc_type: docType,
        file_name: file.name,
        storage_path: path,
        created_at: record.uploaded_at,
      },
    })
  } catch (e) {
    console.warn('[documents] site_events insert failed:', (e as Error).message)
  }

  // Best-effort owner notification. Failure here never blocks the vendor's upload.
  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    const bizName = String(ctx.application.business_name || 'Vendor')
    await notifyOwners({
      event: 'document_uploaded',
      body: `New document uploaded by ${bizName}: ${docType}.`,
      audience: 'all',
    })
  } catch (e) {
    console.error('[documents] notifyOwners failed:', (e as Error).message)
  }

  return NextResponse.json({ success: true, document: record })
}
