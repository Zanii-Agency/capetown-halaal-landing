// Withdrawing a vendor, in ONE place.
//
// The logic already existed inside the admin DELETE route: release every stall
// back to the floor, stamp a reversible ⟦PORTAL⟧ withdrawn marker, set
// status='rejected' so they drop out of every approved-vendor list, and audit
// it. That is correct and hard-won, so this extracts it rather than writing a
// second version for the bot. Two implementations of "release the stalls and
// mark them gone" would drift, and the half that drifts is the one that leaves
// a paid-for booth quietly occupied by someone who left.
//
// Taona 2026-07-29: the bot must handle withdrawals itself. Measured first:
// 6 withdrawal escalations in 9 days, and one of them reads "Layali Haus has
// already requested withdrawal via WhatsApp and email, but is still" being
// chased. We were dunning people who had already quit, because the request
// reached a human queue and stopped there.

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseAllocation } from '@/lib/stalls'
import { parsePortalState, updatePortalStateImpl, hasPaid } from '@/lib/portal-state'

export type WithdrawOutcome =
  | { ok: true; businessName: string; freedStalls: string[] }
  | { ok: false; reason: 'not_found' | 'already_withdrawn' | 'paid_needs_human'; businessName?: string }

/**
 * Withdraw an application. Idempotent, reversible, and refuses on money.
 *
 * A PAID vendor is never withdrawn automatically. Their money raises a refund
 * question that no rule here can answer, and a bot that silently cancels a paid
 * stall is worse than one that asks. Callers get `paid_needs_human` and are
 * expected to escalate.
 */
export async function withdrawApplication(
  db: SupabaseClient,
  args: { applicationId: string; reason?: string | null; actorEmail?: string | null; actorRole?: string },
): Promise<WithdrawOutcome> {
  const { data: before } = await db
    .from('vendor_applications')
    .select('id, business_name, status, admin_notes, paid_at')
    .eq('id', args.applicationId)
    .maybeSingle()
  if (!before) return { ok: false, reason: 'not_found' }

  const businessName = String((before as { business_name?: string }).business_name || 'this vendor')
  const notes = ((before as { admin_notes?: string }).admin_notes) || ''
  const state = parsePortalState(notes)

  if ((state as unknown as { withdrawn?: unknown }).withdrawn) {
    return { ok: false, reason: 'already_withdrawn', businessName }
  }
  if ((before as { paid_at?: string }).paid_at || hasPaid(state)) {
    return { ok: false, reason: 'paid_needs_human', businessName }
  }

  // parseAllocation().human strips ⟦STALL⟧ but keeps prose and ⟦PORTAL⟧, which
  // is what frees the booth for reallocation.
  const { stalls: freedStalls, human: notesNoStall } = parseAllocation(notes)
  const reason = (args.reason || '').trim().slice(0, 280)
  const nowIso = new Date().toISOString()

  ;(state as unknown as { withdrawn: unknown }).withdrawn = {
    at: nowIso,
    by: args.actorEmail ?? null,
    ...(reason ? { reason } : {}),
    ...(freedStalls.length ? { freed_stalls: freedStalls } : {}),
  }

  const newNotes = updatePortalStateImpl(notesNoStall, state)
  const { error } = await db
    .from('vendor_applications')
    .update({ status: 'rejected', admin_notes: newNotes })
    .eq('id', args.applicationId)
  if (error) throw new Error(error.message)

  // Audit, never blocking.
  try {
    await db.from('vendor_application_events').insert({
      application_id: args.applicationId,
      event_type: 'vendor_withdrawn',
      before_value: { status: (before as { status?: string }).status, stalls: freedStalls },
      after_value: { status: 'rejected', withdrawn: (state as unknown as { withdrawn: unknown }).withdrawn },
      actor_email: args.actorEmail ?? null,
      actor_role: args.actorRole ?? 'operator',
      note: reason ? `Vendor withdrawn: ${reason}` : 'Vendor withdrawn (no reason given)',
    })
  } catch (e) {
    console.warn('[withdraw] audit insert failed:', (e as Error).message)
  }

  return { ok: true, businessName, freedStalls }
}
