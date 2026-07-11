/**
 * /api/admin/stall-changes
 *
 * The missing SETTER for the vendor stall-change flow. A vendor requests a
 * change via /api/exhibitor/stand/change (writes stallChangeRequest.status =
 * 'pending' into the portal-state marker on vendor_applications.admin_notes).
 * Nothing previously resolved that request: no operator screen, no approve /
 * reject path, so the vendor's portal showed "pending" forever.
 *
 * GET  : list every application with a pending stallChangeRequest.
 * POST : { id, action: 'approve' | 'reject', note? }
 *   approve -> flip status to 'approved', update preferred_booth_tier to the
 *              requested tier, notify the vendor. Allocation (the ⟦STALL:..⟧
 *              marker) is left untouched: the operator re-allocates manually on
 *              /admin/vendor-ops so we never silently move a vendor off the map.
 *   reject  -> flip status to 'rejected' (+ optional adminNote), notify vendor.
 *
 * CTH-DOCTRINE alignment:
 *  - Law 2 (PII): admin_users + role gate on every request; no public surface.
 *  - Law 8 (stall allocation): no phantom stalls table; state stays on the
 *    admin_notes marker. tier values constrained to valid TIER_META keys.
 *
 * Auth: admin_users with role 'owner' | 'operator'.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState, type PortalState } from '@/lib/portal-state'
import { TIER_META, TYPE_META, tierLabel, type StallType } from '@/lib/stalls'
import { notifyVendor } from '@/lib/notifications'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function requireOperator() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized', status: 401 as const }
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, role').eq('id', user.id).maybeSingle()
  if (!adminUser) return { error: 'forbidden', status: 403 as const }
  const role = ((adminUser as { role?: string }).role || 'viewer').toLowerCase()
  if (!['owner', 'operator'].includes(role)) {
    return { error: 'insufficient_role', status: 403 as const }
  }
  return { db, user }
}

export async function GET() {
  const auth = await requireOperator()
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { db } = auth

  const { data: apps, error } = await db
    .from('vendor_applications')
    .select('id, business_name, admin_notes')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const requests = (apps || [])
    .map((a) => {
      const state = parsePortalState((a.admin_notes as string) || null)
      const cr = state.stallChangeRequest
      if (!cr || cr.status !== 'pending') return null
      return {
        id: a.id as string,
        business_name: (a.business_name as string) || 'Unknown vendor',
        currentTier: cr.currentTier || '',
        currentTierLabel: tierLabel(cr.currentTier),
        requestedTier: cr.requestedTier,
        requestedTierLabel: tierLabel(cr.requestedTier),
        reason: cr.reason || '',
        requestedAt: cr.createdAt || null,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')))

  // Position/location requests (distinct feature: a different SPOT, not a
  // different SIZE). Same admin surface so the operator has one queue.
  const moveRequests = (apps || [])
    .map((a) => {
      const state = parsePortalState((a.admin_notes as string) || null)
      const mr = state.stallMoveRequest
      if (!mr || mr.status !== 'pending') return null
      return {
        id: a.id as string,
        business_name: (a.business_name as string) || 'Unknown vendor',
        preferredZone: mr.preferredZone || null,
        preferredZoneLabel: mr.preferredZone ? (TYPE_META[mr.preferredZone as StallType]?.label || mr.preferredZone) : null,
        currentStall: mr.currentStall || null,
        details: mr.details || '',
        requestedAt: mr.createdAt || null,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')))

  return NextResponse.json({ requests, moveRequests })
}

export async function POST(req: NextRequest) {
  const auth = await requireOperator()
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { db, user } = auth

  const body = await req.json().catch(() => ({}))
  const id = String(body.id || '').trim()
  const action = String(body.action || '') as 'approve' | 'reject'
  const kind = (String(body.kind || 'size') === 'move' ? 'move' : 'size') as 'size' | 'move'
  const note = body.note ? String(body.note).slice(0, 400) : undefined
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (!['approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  }

  // Pull the current pending request so we know the target tier and can guard
  // against acting on a request that is no longer pending (double-click / race).
  const { data: app } = await db
    .from('vendor_applications')
    .select('id, business_name, admin_notes')
    .eq('id', id)
    .maybeSingle()
  if (!app) return NextResponse.json({ error: 'Application not found' }, { status: 404 })

  // POSITION request branch. Resolving it never mutates allocation or tier — the
  // operator re-allocates by hand on /admin/vendor-ops. Approve = acknowledged.
  if (kind === 'move') {
    const moveBefore = parsePortalState((app.admin_notes as string) || null)
    const mr = moveBefore.stallMoveRequest
    if (!mr || mr.status !== 'pending') {
      return NextResponse.json({ error: 'No pending stall position request', code: 'NOT_PENDING' }, { status: 409 })
    }
    const moveStatus: 'approved' | 'rejected' = action === 'approve' ? 'approved' : 'rejected'
    await updatePortalState(id, (s: PortalState) => ({
      ...s,
      stallMoveRequest: s.stallMoveRequest
        ? { ...s.stallMoveRequest, status: moveStatus, ...(note ? { adminNote: note } : {}) }
        : s.stallMoveRequest,
    }))
    try {
      await db.from('vendor_application_events').insert({
        application_id: id,
        event_type: `stall_move_${moveStatus}`,
        after_value: { details: mr.details, preferred_zone: mr.preferredZone || null, status: moveStatus, ...(note ? { note } : {}) },
        actor_email: user.email || null,
        actor_role: 'admin',
        note: action === 'approve' ? 'Stall position request acknowledged' : `Stall position request declined${note ? `: ${note}` : ''}`,
      })
    } catch (e) {
      console.warn('[stall-changes] move event log failed:', (e as Error).message)
    }
    // zanii-codef: no vendor email for position requests yet — the portal
    // reflects the status live. Add a notifyVendor template if vendors ask.
    return NextResponse.json({ ok: true, id, kind: 'move', status: moveStatus, business_name: app.business_name })
  }

  const before = parsePortalState((app.admin_notes as string) || null)
  const cr = before.stallChangeRequest
  if (!cr || cr.status !== 'pending') {
    return NextResponse.json({ error: 'No pending stall change request', code: 'NOT_PENDING' }, { status: 409 })
  }

  const requestedTier = cr.requestedTier
  // Tier must be a valid TIER_META key before we ever write it to
  // preferred_booth_tier (Law 8: keep stall data well-formed).
  if (action === 'approve' && !TIER_META[requestedTier]) {
    return NextResponse.json({ error: `Invalid requested tier: ${requestedTier}` }, { status: 400 })
  }

  const newStatus: 'approved' | 'rejected' = action === 'approve' ? 'approved' : 'rejected'

  // SETTER: flip the request status in the portal-state marker so the vendor's
  // portal stops showing "pending".
  await updatePortalState(id, (s: PortalState) => ({
    ...s,
    stallChangeRequest: s.stallChangeRequest
      ? { ...s.stallChangeRequest, status: newStatus, ...(note ? { adminNote: note } : {}) }
      : s.stallChangeRequest,
  }))

  // On approve, move the vendor to the requested tier. Allocation (⟦STALL:..⟧)
  // is intentionally left as-is: the operator re-allocates manually on
  // /admin/vendor-ops so a tier change never silently strands a vendor on a
  // stall that no longer fits their booth size.
  if (action === 'approve') {
    const { error: updErr } = await db
      .from('vendor_applications')
      .update({ preferred_booth_tier: requestedTier })
      .eq('id', id)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  // Audit. Never fake success: if the event log fails we log it but the state
  // write above is the durable source of truth.
  try {
    await db.from('vendor_application_events').insert({
      application_id: id,
      event_type: `stall_change_${newStatus}`,
      after_value: {
        from_tier: cr.currentTier || null,
        to_tier: requestedTier,
        status: newStatus,
        ...(note ? { note } : {}),
      },
      actor_email: user.email || null,
      actor_role: 'admin',
      note: action === 'approve'
        ? `Stall change approved: ${tierLabel(cr.currentTier)} -> ${tierLabel(requestedTier)}`
        : `Stall change rejected${note ? `: ${note}` : ''}`,
    })
  } catch (e) {
    console.warn('[stall-changes] event log failed:', (e as Error).message)
  }

  // Notify the vendor on the channels they opted into. Best-effort.
  await notifyVendor({
    event: action === 'approve' ? 'stall_change_approved' : 'stall_change_rejected',
    applicationId: id,
    data: {
      ...(action === 'approve' ? { tier: tierLabel(requestedTier) } : {}),
      ...(action === 'reject' && note ? { reason: note } : {}),
    },
  }).catch((e) =>
    console.error('[stall-changes] notifyVendor failed:', (e as Error).message)
  )

  return NextResponse.json({ ok: true, id, status: newStatus, business_name: app.business_name })
}
