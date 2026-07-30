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
import { TIER_META, TYPE_META, tierLabel, resolveTierSlug, type StallType } from '@/lib/stalls'
import { tierPricingFields } from '@/lib/payments/pricing'
import { notifyVendor } from '@/lib/notifications'
import { sendText } from '@/lib/whatsapp'
import { windowOpenFor } from '@/lib/wa-window'

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
  // Law 7 at the source. This admin-typed note reaches the vendor on TWO legs:
  // WhatsApp (scrubbed by sendText) and email (not). Strip the long dash here,
  // once, so both legs carry clean copy instead of only one. A dash used as a
  // sentence break becomes a comma, per the doctrine.
  const note = body.note
    ? String(body.note).replace(/\s*[—–]\s*/g, ', ').slice(0, 400)
    : undefined
  // OPERATOR OVERRIDE for a request the matcher cannot resolve.
  //
  // resolveTierSlug is deliberately conservative and returns null unless the
  // free text names exactly ONE tier, so nobody is charged for a guessed size.
  // That is correct, and it produced a DEAD END: a vendor asking for a
  // "2.4m x 1.8m trailer" (not one of the ten tiers, because vendors describe
  // their own equipment) left the operator with a 400 and an instruction to go
  // to a different page. Every unmatchable phrasing became a manual detour.
  //
  // So the operator can now name the tier at the point of decision. It is
  // validated against TIER_META like any other, so an override still cannot
  // invent a price.
  const tierOverride = body.tier ? String(body.tier).trim() : ''
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (!['approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  }

  // Pull the current pending request so we know the target tier and can guard
  // against acting on a request that is no longer pending (double-click / race).
  const { data: app } = await db
    .from('vendor_applications')
    .select('id, business_name, admin_notes, special_requirements, phone')
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

  // Resolve the vendor's FREE-TEXT request (e.g. "3x3m Full Marquee", as the
  // WhatsApp bot stores it) to a canonical TIER_META slug. Previously the flow
  // validated the free text against TIER_META directly, so it never matched and
  // the booth change got stuck (Samreen voice note, 2026-07-21). resolveTierSlug
  // returns null when the text is ambiguous, so we never approve a mis-priced tier.
  // An override wins over the matcher, but only if it is a real tier.
  if (tierOverride && !TIER_META[tierOverride]) {
    return NextResponse.json({ error: `Unknown stall tier "${tierOverride}".`, code: 'BAD_TIER' }, { status: 400 })
  }
  const requestedTier = tierOverride || resolveTierSlug(cr.requestedTier) || ''
  if (action === 'approve' && !TIER_META[requestedTier]) {
    // Hand the caller the choices so the UI can ask instead of dead-ending.
    return NextResponse.json({
      error: `"${cr.requestedTier}" is not one of our stall sizes. Pick the tier to move them to.`,
      code: 'UNRESOLVED_TIER',
      requestedText: cr.requestedTier,
      tiers: Object.entries(TIER_META).map(([slug, m]) => ({ slug, label: m.label, price: m.price })),
    }, { status: 400 })
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
    // Sync the frozen display snapshot to the new tier via the shared helper
    // (same wall as the manual vendor-edit path), so the admin application page
    // never shows/charges the OLD size after an approve.
    let sr: Record<string, unknown> = {}
    try {
      const rawSr = app.special_requirements
      sr = typeof rawSr === 'string' ? JSON.parse(rawSr) : ((rawSr as Record<string, unknown>) || {})
    } catch { sr = {} }
    const fields = tierPricingFields(requestedTier, sr as { stall_price?: number; total_estimate?: number })
    if (fields) Object.assign(sr, fields)
    const { error: updErr } = await db
      .from('vendor_applications')
      .update({ preferred_booth_tier: requestedTier, special_requirements: JSON.stringify(sr) })
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

  // ANSWER THEM WHERE THEY ASKED. Most of these arrive over WhatsApp (the bot
  // logs the request), and there is no approved Meta template for a decline, so
  // notifyVendor's WA leg skips and the vendor only ever gets an email about a
  // WhatsApp conversation. Free text needs no template while the 24h service
  // window is open, and a vendor who just messaged us is almost always inside
  // it. Outside the window this is a no-op and the email stands alone.
  let waNote: string | null = null
  const phone = (app as Record<string, unknown>).phone as string | undefined
  if (note && phone) {
    try {
      if (await windowOpenFor(phone)) {
        const line = action === 'approve'
          ? `Good news, your stall change to ${tierLabel(requestedTier)} is approved. ${note}`
          : `About your stall change request: ${note}`
        const r = await sendText(phone, line)
        waNote = r.skipped ? `skipped: ${r.skipped}` : 'sent'
      } else {
        waNote = 'skipped: outside the 24h window, emailed instead'
      }
    } catch (e) {
      waNote = `failed: ${(e as Error).message}`
      console.error('[stall-changes] whatsapp note failed:', (e as Error).message)
    }
  }

  return NextResponse.json({ ok: true, id, status: newStatus, business_name: app.business_name, whatsapp: waNote })
}
