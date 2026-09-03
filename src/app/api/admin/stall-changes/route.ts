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
import { executeStallChangeAction } from '@/lib/stall-change-action'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { TYPE_META, tierLabel, type StallType } from '@/lib/stalls'
import { recordAdminAction } from '@/lib/zanii-ledger'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function requireOperator() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized', status: 401 as const }
  const { createAdminClient } = await import('@/lib/supabase/admin')
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, role').eq('id', user.id).maybeSingle()
  if (!adminUser) return { error: 'forbidden', status: 403 as const }
  const role = ((adminUser as { role?: string }).role || 'viewer').toLowerCase()
  if (!['owner', 'operator'].includes(role)) {
    return { error: 'insufficient_role', status: 403 as const }
  }
  return { user }
}

export async function GET() {
  const auth = await requireOperator()
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const size: Array<{
    id: string
    business_name: string
    currentTier: string
    currentTierLabel: string
    requestedTier: string
    requestedTierLabel: string
    reason: string
    requestedAt: string | null
  }> = []
  const move: Array<{
    id: string
    business_name: string
    preferredZone: string | null
    preferredZoneLabel: string | null
    currentStall: string | null
    details: string
    requestedAt: string | null
  }> = []

  // Read via the SERVICE client, not the RLS-bound user client. requireOperator()
  // already authorized the caller; the authed client's select on
  // vendor_applications fails with "infinite recursion detected in policy for
  // relation admin_users", so `apps` came back null and BOTH queues rendered
  // empty for every operator (Samreen included) while 14 requests sat pending.
  // Every sibling admin route reads through the service client for this reason.
  const db = createAdminClient()
  const { data: apps, error } = await db.from('vendor_applications').select('id, business_name, admin_notes')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  for (const a of (apps || []) as Array<{ id: string; business_name: string | null; admin_notes: string | null }>) {
    const state = parsePortalState(a.admin_notes)
    const cr = state.stallChangeRequest
    if (cr && cr.status === 'pending') {
      size.push({
        id: a.id,
        business_name: (a.business_name as string) || 'Unknown vendor',
        currentTier: cr.currentTier || '',
        currentTierLabel: tierLabel(cr.currentTier),
        requestedTier: cr.requestedTier,
        requestedTierLabel: tierLabel(cr.requestedTier),
        reason: cr.reason || '',
        requestedAt: cr.createdAt || null,
      })
    }
    const mr = state.stallMoveRequest
    if (mr && mr.status === 'pending') {
      move.push({
        id: a.id,
        business_name: (a.business_name as string) || 'Unknown vendor',
        preferredZone: mr.preferredZone || null,
        preferredZoneLabel: mr.preferredZone ? (TYPE_META[mr.preferredZone as StallType]?.label || mr.preferredZone) : null,
        currentStall: mr.currentStall || null,
        details: mr.details || '',
        requestedAt: mr.createdAt || null,
      })
    }
  }
  size.sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')))
  move.sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')))
  return NextResponse.json({ requests: size, moveRequests: move })
}

export async function POST(req: NextRequest) {
  const auth = await requireOperator()
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { user } = auth

  const body = await req.json().catch(() => ({}))
  const id = String(body.id || '').trim()
  const action = String(body.action || '') as 'approve' | 'reject'
  const kind = (String(body.kind || 'size') === 'move' ? 'move' : 'size') as 'size' | 'move'
  const note = body.note ? String(body.note) : undefined
  const tierOverride = body.tier ? String(body.tier).trim() : undefined

  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (!['approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  }

  const result = await executeStallChangeAction({
    applicationId: id,
    action,
    kind,
    tierOverride,
    note,
    actorEmail: user.email,
    actorRole: 'admin',
  })

  if (!result.ok) {
    const status = result.code === 'NOT_PENDING' ? 409 : result.code === 'UNRESOLVED_TIER' || result.code === 'BAD_TIER' ? 400 : 500
    const payload: Record<string, unknown> = { error: result.error }
    if (result.code) payload.code = result.code
    if (result.requestedText) payload.requestedText = result.requestedText
    if (result.tiers) payload.tiers = result.tiers
    return NextResponse.json(payload, { status })
  }

  await recordAdminAction({
    actor: { email: user.email ?? null, role: null },
    action: 'stall_change',
    vendorId: id,
    payload: { kind, action, status: result.status, tier: tierOverride || null, note: note || null },
  })

  return NextResponse.json({ ok: true, id, status: result.status, kind })
}
