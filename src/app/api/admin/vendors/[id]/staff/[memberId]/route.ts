/**
 * DELETE /api/admin/vendors/[id]/staff/[memberId]
 *
 * Admin revoke for a staff badge. Cancels the underlying WC order (FooEvents
 * invalidates the ticket on the cancel hook) and stamps a `revoked_at`
 * tombstone on the portal_state.staff entry so the audit trail is preserved.
 *
 * Soft-delete by default: we do NOT remove the row from portal_state — gate
 * staff need to see "this badge was revoked" rather than "this badge never
 * existed".
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'
import { cancelStaffBadgeOrder } from '@/lib/woocommerce'
import { requireOperator } from '@/lib/admin-rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  const { id, memberId } = await params
  if (!id || !memberId) return NextResponse.json({ error: 'id + memberId required' }, { status: 400 })

  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  const { user } = gate
  const db = createAdminClient()

  const { data: appRow } = await db.from('vendor_applications').select('admin_notes').eq('id', id).maybeSingle()
  const state = parsePortalState((appRow?.admin_notes as string) || '')
  const target = (state.staff || []).find((m) => m.id === memberId)
  if (!target) return NextResponse.json({ error: 'staff member not found' }, { status: 404 })

  if (target.wc_order_id) {
    try { await cancelStaffBadgeOrder(target.wc_order_id) }
    catch (e) { console.warn('[admin/staff revoke] WC cancel failed (still tombstoning portal_state):', e) }
  }

  const revokedAt = new Date().toISOString()
  const next = await updatePortalState(id, (s) => ({
    ...s,
    staff: (s.staff || []).map((m) => m.id === memberId ? { ...m, revoked_at: revokedAt } : m),
  }))

  try {
    await db.from('vendor_application_events').insert({
      application_id: id,
      event_type: 'staff_badge_revoked',
      after_value: { staff_id: memberId, wc_order_id: target.wc_order_id || null },
      actor_email: user.email || null,
      actor_role: 'admin',
      note: `Revoked staff badge for ${target.name}`,
    })
  } catch (e) {
    console.warn('[admin/staff revoke] event log failed:', (e as Error).message)
  }

  return NextResponse.json({ ok: true, staff: next.staff || [] })
}
