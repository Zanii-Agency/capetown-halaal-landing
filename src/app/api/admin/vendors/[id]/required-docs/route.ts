/**
 * POST /api/admin/vendors/[id]/required-docs
 *
 * Add or remove one per-vendor required document (e.g. gas certificate after a
 * chat). Stored as a ⟦REQDOC:<type>⟧ marker on admin_notes (Law 8, no DDL) and
 * merged by getRequiredDocs, so the vendor portal shows it as required too.
 * No vendor notification: use "Request documents" to chase.
 *
 * Body: { type: string, on: boolean }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'
import { laneScopeFor } from '@/lib/inbox-lane'
import { EXTRA_DOC_TYPES, extraRequiredDocs, withExtraRequiredDoc } from '@/lib/exhibitor/required-docs'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  const scope = await laneScopeFor(gate.user.email)
  if (scope.blocksApplicationId(id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const type = String(body.type || '').trim()
  const on = body.on !== false
  if (!(EXTRA_DOC_TYPES as readonly string[]).includes(type)) {
    return NextResponse.json({ error: 'invalid type' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data, error } = await db.from('vendor_applications').select('admin_notes').eq('id', id).maybeSingle()
  if (error || !data) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const notes = withExtraRequiredDoc(data.admin_notes as string | null, type, on)
  const { error: upErr } = await db.from('vendor_applications').update({ admin_notes: notes }).eq('id', id)
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  try {
    await db.from('vendor_application_events').insert({
      application_id: id,
      event_type: on ? 'required_doc_added' : 'required_doc_removed',
      after_value: { type },
      actor_email: gate.user.email || null,
      actor_role: 'admin',
      note: `Required document ${type} ${on ? 'added' : 'removed'}`,
    })
  } catch (e) {
    console.warn('required-docs: event log failed:', (e as Error).message)
  }

  return NextResponse.json({ ok: true, extra: extraRequiredDocs(notes) })
}
