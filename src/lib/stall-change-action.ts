// Shared core for approving / rejecting vendor stall-change requests.
// Used by the admin HTTP route (/api/admin/stall-changes) and the master
// WhatsApp command surface (src/lib/bot/admin-chat.ts). Keeping one copy of
// the rule prevents the two paths from drifting apart.

import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState, type PortalState } from '@/lib/portal-state'
import { TIER_META, tierLabel, resolveTierSlug, type StallType, TYPE_META } from '@/lib/stalls'
import { tierPricingFields } from '@/lib/payments/pricing'
import { notifyVendor } from '@/lib/notifications'
import { sendText } from '@/lib/whatsapp'
import { windowOpenFor } from '@/lib/wa-window'

export interface StallChangeActionInput {
  applicationId: string
  action: 'approve' | 'reject'
  /** 'size' = stallChangeRequest (booth tier change). 'move' = stallMoveRequest (position change). */
  kind?: 'size' | 'move'
  /** Operator override when the vendor's free-text request does not resolve to a single tier. */
  tierOverride?: string
  /** Admin note sent to the vendor on approve/reject. */
  note?: string
  actorEmail?: string | null
  actorRole?: string | null
}

export interface StallChangeActionResult {
  ok: boolean
  status?: 'approved' | 'rejected'
  error?: string
  code?: string
  requestedText?: string
  tiers?: Array<{ slug: string; label: string; price: number }>
}

function safeNote(note?: string): string | undefined {
  if (!note) return undefined
  return note.replace(/\s*[—–]\s*/g, ', ').slice(0, 400)
}

export async function executeStallChangeAction(input: StallChangeActionInput): Promise<StallChangeActionResult> {
  const db = createAdminClient()
  const id = input.applicationId
  const action = input.action
  const kind = input.kind || 'size'
  const note = safeNote(input.note)

  const { data: app } = await db
    .from('vendor_applications')
    .select('id, business_name, admin_notes, special_requirements, phone')
    .eq('id', id)
    .maybeSingle()
  if (!app) return { ok: false, error: 'Application not found' }

  const before = parsePortalState((app.admin_notes as string) || null)
  const finalStatus: 'approved' | 'rejected' = action === 'approve' ? 'approved' : 'rejected'

  // POSITION / MOVE request branch
  if (kind === 'move') {
    const mr = before.stallMoveRequest
    if (!mr || mr.status !== 'pending') {
      return { ok: false, error: 'No pending stall position request', code: 'NOT_PENDING' }
    }
    await updatePortalState(id, (s: PortalState) => ({
      ...s,
      stallMoveRequest: s.stallMoveRequest
        ? { ...s.stallMoveRequest, status: finalStatus, ...(note ? { adminNote: note } : {}) }
        : s.stallMoveRequest,
    }))
    try {
      await db.from('vendor_application_events').insert({
        application_id: id,
        event_type: `stall_move_${finalStatus}`,
        after_value: { details: mr.details, preferred_zone: mr.preferredZone || null, status: finalStatus, ...(note ? { note } : {}) },
        actor_email: input.actorEmail || null,
        actor_role: input.actorRole || 'admin',
        note: finalStatus === 'approved' ? 'Stall position request acknowledged' : `Stall position request declined${note ? `: ${note}` : ''}`,
      })
    } catch (e) {
      console.warn('[stall-change-action] move event log failed:', (e as Error).message)
    }
    return { ok: true, status: finalStatus }
  }

  // SIZE / TIER change branch
  const cr = before.stallChangeRequest
  if (!cr || cr.status !== 'pending') {
    return { ok: false, error: 'No pending stall change request', code: 'NOT_PENDING' }
  }

  const tierOverride = (input.tierOverride || '').trim()
  if (tierOverride && !TIER_META[tierOverride]) {
    return { ok: false, error: `Unknown stall tier "${tierOverride}".`, code: 'BAD_TIER' }
  }
  const requestedTier = tierOverride || resolveTierSlug(cr.requestedTier) || ''
  if (action === 'approve' && !TIER_META[requestedTier]) {
    return {
      ok: false,
      error: `"${cr.requestedTier}" is not one of our stall sizes. Pick the tier to move them to.`,
      code: 'UNRESOLVED_TIER',
      requestedText: cr.requestedTier,
      tiers: Object.entries(TIER_META).map(([slug, m]) => ({ slug, label: m.label, price: m.price })),
    }
  }

  await updatePortalState(id, (s: PortalState) => ({
    ...s,
    stallChangeRequest: s.stallChangeRequest
      ? { ...s.stallChangeRequest, status: finalStatus, ...(note ? { adminNote: note } : {}) }
      : s.stallChangeRequest,
  }))

  if (action === 'approve') {
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
    if (updErr) return { ok: false, error: updErr.message }
  }

  try {
    await db.from('vendor_application_events').insert({
      application_id: id,
      event_type: `stall_change_${finalStatus}`,
      after_value: {
        from_tier: cr.currentTier || null,
        to_tier: requestedTier,
        status: finalStatus,
        ...(note ? { note } : {}),
      },
      actor_email: input.actorEmail || null,
      actor_role: input.actorRole || 'admin',
      note: finalStatus === 'approved'
        ? `Stall change approved: ${tierLabel(cr.currentTier)} -> ${tierLabel(requestedTier)}`
        : `Stall change rejected${note ? `: ${note}` : ''}`,
    })
  } catch (e) {
    console.warn('[stall-change-action] event log failed:', (e as Error).message)
  }

  await notifyVendor({
    event: finalStatus === 'approved' ? 'stall_change_approved' : 'stall_change_rejected',
    applicationId: id,
    data: {
      ...(action === 'approve' ? { tier: tierLabel(requestedTier) } : {}),
      ...(action === 'reject' && note ? { reason: note } : {}),
    },
  }).catch((e) => console.error('[stall-change-action] notifyVendor failed:', (e as Error).message))

  const phone = (app as Record<string, unknown>).phone as string | undefined
  if (note && phone) {
    try {
      if (await windowOpenFor(phone)) {
        const line = action === 'approve'
          ? `Good news, your stall change to ${tierLabel(requestedTier)} is approved. ${note}`
          : `About your stall change request: ${note}`
        await sendText(phone, line)
      }
    } catch (e) {
      console.error('[stall-change-action] whatsapp note failed:', (e as Error).message)
    }
  }

  return { ok: true, status: finalStatus }
}

/** List every application with a pending stall-change or stall-move request. */
export async function pendingStallChangeRequests(): Promise<string> {
  const db = createAdminClient()
  const { data: apps, error } = await db.from('vendor_applications').select('id, business_name, admin_notes')
  if (error) return `Could not load requests: ${error.message}`

  const size: string[] = []
  const move: string[] = []
  for (const a of (apps || []) as Array<{ id: string; business_name: string | null; admin_notes: string | null }>) {
    const state = parsePortalState(a.admin_notes)
    const cr = state.stallChangeRequest
    if (cr && cr.status === 'pending') {
      size.push(`- ${a.business_name || 'Unnamed'} [${a.id.slice(0, 8)}]: ${tierLabel(cr.currentTier)} -> ${tierLabel(cr.requestedTier)}${cr.reason ? ` (${cr.reason})` : ''}`)
    }
    const mr = state.stallMoveRequest
    if (mr && mr.status === 'pending') {
      move.push(`- ${a.business_name || 'Unnamed'} [${a.id.slice(0, 8)}]: ${mr.details}${mr.preferredZone ? ` (prefers ${TYPE_META[mr.preferredZone as StallType]?.label || mr.preferredZone})` : ''}`)
    }
  }

  const lines: string[] = []
  lines.push(`Pending size changes: ${size.length}`)
  lines.push(...size)
  lines.push(`Pending position moves: ${move.length}`)
  lines.push(...move)
  return lines.join('\n')
}
