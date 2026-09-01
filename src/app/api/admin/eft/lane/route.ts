import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEftAdmin, hasEftMarker, withEftMarker, withoutEftMarker, withNoEftMarker, withoutNoEftMarker } from '@/lib/eft'
import { recordAdminAction } from '@/lib/zanii-ledger'

export const runtime = 'nodejs'

// TEMPORARY EFT lane, per-vendor state on admin_notes (preserves ⟦PORTAL⟧/⟦STALL⟧/
// prose). Restricted to the EFT admin. Actions:
//   add       -> ⟦EFT⟧    (put in the lane: EFT view + comms move to the dev tab)
//   remove    -> drop ⟦EFT⟧
//   exclude   -> ⟦NOEFT⟧  (handle manually: never EFT, comms stay on main; also drops ⟦EFT⟧)
//   unexclude -> drop ⟦NOEFT⟧
const ACTIONS = ['add', 'remove', 'exclude', 'unexclude'] as const
type Action = (typeof ACTIONS)[number]

export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  if (!isEftAdmin(gate.adminUser.email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { applicationId?: string; action?: string }
  const id = String(body.applicationId || '')
  const action = (ACTIONS as readonly string[]).includes(body.action || '') ? (body.action as Action) : null
  if (!id || !action) return NextResponse.json({ error: 'applicationId and action (add|remove|exclude|unexclude) required' }, { status: 400 })

  const admin = createAdminClient()
  const { data, error } = await admin.from('vendor_applications').select('admin_notes').eq('id', id).maybeSingle()
  if (error || !data) return NextResponse.json({ error: 'vendor not found' }, { status: 404 })

  const notes = data.admin_notes as string
  const next =
    action === 'add' ? withEftMarker(notes)
    : action === 'remove' ? withoutEftMarker(notes)
    : action === 'exclude' ? withNoEftMarker(notes)
    : withoutNoEftMarker(notes)
  const { error: upErr } = await admin.from('vendor_applications').update({ admin_notes: next }).eq('id', id)
  if (upErr) {
    console.error('[eft/lane] update failed:', upErr.message)
    return NextResponse.json({ error: 'could not update' }, { status: 500 })
  }

  // Audit. This wrote to a `metadata` column that DOES NOT EXIST on
  // vendor_application_events, inside a bare `catch {}`, so every lane change
  // since this endpoint shipped failed to record and said nothing: the table
  // holds 0 eft_lane rows. That is why the lane could not show when a vendor was
  // added. Real columns now, and a LOUD catch, because a silent audit is
  // indistinguishable from no audit.
  const { error: evErr } = await admin.from('vendor_application_events').insert({
    application_id: id,
    event_type: `eft_lane_${action}`,
    actor_email: gate.adminUser.email,
    actor_role: gate.adminUser.role ?? null,
    before_value: hasEftMarker(notes) ? 'in_lane' : 'out',
    after_value: action === 'add' ? 'in_lane' : action === 'remove' ? 'out' : action,
    note: `EFT lane ${action}`,
  })
  if (evErr) console.error('[eft/lane] audit insert failed:', evErr.message)

  await recordAdminAction({
    actor: { email: gate.adminUser.email, role: gate.role },
    action: 'eft_lane',
    vendorId: id,
    payload: { action, before: hasEftMarker(notes) ? 'in_lane' : 'out', after: action === 'add' ? 'in_lane' : action === 'remove' ? 'out' : action },
  })

  return NextResponse.json({ ok: true })
}
