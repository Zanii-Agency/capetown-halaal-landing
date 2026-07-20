/**
 * POST /api/admin/vendors/[id]/payment-proof
 *
 * Operator-only. Upload an EFT receipt (for extra payments made by bank
 * transfer) or a refund proof for a vendor. The file lands in the PRIVATE
 * vendor-docs bucket; the reference is appended to the ⟦PORTAL⟧ marker on
 * vendor_applications.admin_notes (no spare DB columns, DDL is blocked here).
 *
 * Law 2 (PII): vendor-docs is private. We NEVER return a public URL, only the
 * storage path. The vendor portal mints a short-lived signed URL server-side.
 *
 * Body: multipart/form-data
 *   - file:  the receipt/proof file (required)
 *   - kind:  'receipt' | 'refund' (default 'receipt')
 *   - note:  optional free text, <= 300 chars
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState } from '@/lib/portal-state'
import { requireOperator } from '@/lib/admin-rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BUCKET = 'vendor-docs'
const MAX_BYTES = 10 * 1024 * 1024 // 10MB
const ALLOWED_KINDS = ['receipt', 'refund'] as const
type ProofKind = (typeof ALLOWED_KINDS)[number]
// Safe content-types: pdf + the common image formats a bank receipt arrives in.
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
])

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  // Validate the application id is a UUID before it ever lands in a storage
  // path, matching the sibling admin routes (no traversal, no orphan objects).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

  // 401-before-403, owner/operator only.
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  const { user } = gate

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 })
  }
  if (!ALLOWED_TYPES.has((file.type || '').toLowerCase())) {
    return NextResponse.json(
      { error: 'Invalid file type (allowed: pdf, png, jpg, jpeg, webp)' },
      { status: 400 }
    )
  }

  const kindRaw = String(form?.get('kind') || 'receipt').toLowerCase()
  if (!(ALLOWED_KINDS as readonly string[]).includes(kindRaw)) {
    return NextResponse.json({ error: "Invalid kind (allowed: receipt, refund)" }, { status: 400 })
  }
  const kind = kindRaw as ProofKind

  const noteRaw = form?.get('note')
  const note = noteRaw ? String(noteRaw).slice(0, 300) : undefined

  const ext = (file.name.split('.').pop() || 'bin')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10) || 'bin'
  const path = `${id}/payment-proof-${Date.now()}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  const admin = createAdminClient()
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buffer, {
    contentType: file.type || 'application/octet-stream',
    upsert: true,
  })
  if (upErr) {
    console.error('[payment-proof] upload failed:', upErr.message)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }

  const newProof = {
    path,
    kind,
    note,
    uploaded_at: new Date().toISOString(),
  }

  await updatePortalState(id, (s) => ({
    ...s,
    payment: {
      ...(s.payment || {}),
      proofs: [...(s.payment?.proofs || []), newProof],
    },
  }))

  // Best-effort audit. Never block the upload on a logging failure.
  try {
    await admin.from('vendor_application_events').insert({
      application_id: id,
      event_type: 'payment_proof_uploaded',
      after_value: { kind, note, path },
      actor_email: user.email || null,
      actor_role: 'admin',
      note: `EFT ${kind} proof uploaded`,
    })
  } catch (e) {
    console.warn('[payment-proof] event log insert failed:', (e as Error).message)
  }

  return NextResponse.json({ ok: true, proof: newProof })
}
