// A vendor "case" = what the team owes a vendor right now. DERIVED, never stored:
// the vendor's portal support thread already records every hand-over the bot
// makes (escalate_to_human) and every portal question, so an open case is simply
// the vendor's asks since the team last answered. Law 8 (no DDL) is why this is
// derived instead of a cases table.
//
// Why it exists (2026-09-23 audit): the bot promises "the team replies within 24
// to 72 hours" on every hand-over; of 68 hand-overs in 30 days only 4 got a human
// reply within 72h, and vendors who chased were escalated again as NEW items
// (Amazen, Scarfworld, Rose Collection, Stage Zero). One case, one clock, repeats
// bump it.
import type { PortalState } from '@/lib/portal-state'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'
import type { createAdminClient } from '@/lib/supabase/admin'

export const CASE_PROMISE_HOURS = 72

export interface OpenCase {
  openedAt: string   // first unanswered ask
  lastAskAt: string
  asks: number       // unanswered asks (1 = asked once, 2+ = chased)
  dueAt: string      // openedAt + the 72h the bot promised
  overdue: boolean
  firstAsk: string
  latestAsk: string
}

/** The open case on a portal state, or null. Closed by an admin reply in the
 *  portal thread OR by `supportResolvedAt` (a human answered on WhatsApp/email). */
export function openCase(s: Pick<PortalState, 'support' | 'supportResolvedAt'>, now = Date.now()): OpenCase | null {
  const msgs = (s.support || []).slice().sort((a, b) => a.at.localeCompare(b.at))
  const lastAdmin = [...msgs].reverse().find((m) => m.from === 'admin')?.at || ''
  const cut = [lastAdmin, s.supportResolvedAt || ''].sort().pop() || ''
  const open = msgs.filter((m) => m.from === 'vendor' && m.at > cut)
  if (!open.length) return null
  const dueAt = new Date(Date.parse(open[0].at) + CASE_PROMISE_HOURS * 3600_000).toISOString()
  return {
    openedAt: open[0].at,
    lastAskAt: open[open.length - 1].at,
    asks: open.length,
    dueAt,
    overdue: Date.parse(dueAt) < now,
    firstAsk: open[0].body,
    latestAsk: open[open.length - 1].body,
  }
}

/** A human just answered this vendor on WhatsApp or email: close their open case.
 *  Matches by phone (last 9, incl. ⟦WAV⟧ bound numbers) or exact email. Best-effort,
 *  never breaks the reply that called it. */
export async function resolveSupportCase(
  db: ReturnType<typeof createAdminClient>,
  who: { phone?: string | null; email?: string | null },
): Promise<number> {
  try {
    const last9 = (who.phone || '').replace(/\D/g, '').slice(-9)
    const email = (who.email || '').trim().toLowerCase()
    const ors = [
      ...(last9.length === 9 ? [`phone.like.*${last9}`, `admin_notes.like.*WAV${last9}*`] : []),
      ...(email && !/[,()]/.test(email) ? [`email.ilike.${email.replace(/[%_\\]/g, (c) => `\\${c}`)}`] : []), // escape ilike wildcards: "_" is common in addresses
    ]
    if (!ors.length) return 0
    const { data } = await db.from('vendor_applications').select('id, admin_notes').or(ors.join(','))
    let closed = 0
    for (const r of (data || []) as Array<{ id: string; admin_notes: string | null }>) {
      if (!openCase(parsePortalState(r.admin_notes))) continue
      await updatePortalState(r.id, (s) => ({ ...s, supportResolvedAt: new Date().toISOString() }))
      closed++
    }
    return closed
  } catch (e) {
    console.error('[resolveSupportCase] failed:', (e as Error).message)
    return 0
  }
}

/** "14 September", Cape Town time, for vendor-facing case dates. */
export function fmtCaseDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', timeZone: 'Africa/Johannesburg' })
}

// ── Settled by what happened next ─────────────────────────────────────────────
// 2026-09-23 audit: 21 of 43 "open" cases were already settled, just not by a typed
// reply: the vendor paid, the application or stall change was decided, or they
// withdrew. A question counts as answered when a LATER event settles its subject.
// Keyed on what the ask is about, so paying never closes an unrelated request
// (El chapo asked to drop R1,000 of appliances; a later payment answers nothing).
const PAY_ASK = /\b(pay|paid|payment|pop|proof|invoice|extension|instal|split|arrangement|reference|eft|deposit|due date|deadline|fee)\w*/i
const STATUS_ASK = /\b(accept|approv|application|status|chosen|selected|successful|confirm)\w*/i
const STALL_ASK = /\b(stall change|upgrade|bigger|smaller|size|move|bedouin|marquee|gazebo|split)\w*/i

export interface SettleRow {
  status?: string | null
  reviewed_at?: string | null
  paid_at?: string | null
  admin_notes?: string | null
}

/** Why a question asked at `askedAt` is already settled, or null if it is not. */
export function settledBy(ask: string, askedAt: string, row: SettleRow): string | null {
  const s = parsePortalState(row.admin_notes)
  const withdrawnAt = (s as { withdrawn?: { at?: string } }).withdrawn?.at
  if (withdrawnAt && withdrawnAt > askedAt) return 'withdrew'
  const p = s.payment as { paid_at?: string; eft_collected_at?: string } | undefined
  const paidAt = row.paid_at || p?.paid_at || p?.eft_collected_at
  if (paidAt && paidAt > askedAt && PAY_ASK.test(ask)) return 'paid'
  if (row.reviewed_at && row.reviewed_at > askedAt && STATUS_ASK.test(ask) && (row.status === 'approved' || row.status === 'rejected')) return 'decided'
  const sc = s.stallChangeRequest
  if (sc && sc.status !== 'pending' && STALL_ASK.test(ask)) return 'stall change decided'
  return null
}

/** The open case, unless something that happened after it settled it. */
export function openCaseFor(row: SettleRow, now = Date.now()): OpenCase | null {
  const c = openCase(parsePortalState(row.admin_notes), now)
  if (!c) return null
  return settledBy(`${c.firstAsk} ${c.latestAsk}`, c.lastAskAt, row) ? null : c
}
