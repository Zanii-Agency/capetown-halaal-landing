import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEftAdmin, withEftMarker, withoutEftMarker } from '@/lib/eft'

export const runtime = 'nodejs'

// TEMPORARY EFT lane: add/remove one vendor from the lane (the ⟦EFT⟧ marker on
// admin_notes). Preserves ⟦PORTAL⟧/⟦STALL⟧/prose. Restricted to the EFT admin.
export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  if (!isEftAdmin(gate.adminUser.email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { applicationId?: string; action?: string }
  const id = String(body.applicationId || '')
  const action = body.action === 'remove' ? 'remove' : body.action === 'add' ? 'add' : null
  if (!id || !action) return NextResponse.json({ error: 'applicationId and action (add|remove) required' }, { status: 400 })

  const admin = createAdminClient()
  const { data, error } = await admin.from('vendor_applications').select('admin_notes').eq('id', id).maybeSingle()
  if (error || !data) return NextResponse.json({ error: 'vendor not found' }, { status: 404 })

  const next = action === 'add'
    ? withEftMarker(data.admin_notes as string)
    : withoutEftMarker(data.admin_notes as string)
  const { error: upErr } = await admin.from('vendor_applications').update({ admin_notes: next }).eq('id', id)
  if (upErr) {
    console.error('[eft/lane] update failed:', upErr.message)
    return NextResponse.json({ error: 'could not update' }, { status: 500 })
  }

  // Best-effort audit; never blocks the lane change.
  try {
    await admin.from('vendor_application_events').insert({
      application_id: id,
      event_type: action === 'add' ? 'eft_lane_added' : 'eft_lane_removed',
      metadata: { by: gate.adminUser.email },
    })
  } catch { /* schema/audit is secondary */ }

  return NextResponse.json({ ok: true })
}
