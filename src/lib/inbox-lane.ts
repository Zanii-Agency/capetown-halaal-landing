// TEMPORARY EFT lane — read-side visibility for every admin surface that returns
// message content.
//
// The unified inbox filters the thread LIST (api/admin/inbox/unified/route.ts) and
// api/admin/inbox/unified/messages guards one thread. But ~11 other admin endpoints
// read wa_messages / support_inbox_messages with a caller-supplied phone, email,
// application id or ticket id — and two of them (support-inbox/threads, sent) take
// no identifier at all and return the whole table. A filtered list in front of
// unfiltered readers is a cosmetic seal: the festival owner never has to click a
// hidden thread, she can just call the route (KT #48 — a gated vendor still has
// ungated doors; enumerate the edges).
//
// One scope object per request answers "may this viewer see this vendor?" for all
// three identifier shapes, so a new reader gets the rule by using the scope rather
// than by remembering to re-derive it. Same shape as the notifyOwners gate: the
// predicate lives in ONE place (vendorCommsInEftLane) and callers pass identity.
import { createAdminClient } from '@/lib/supabase/admin'
import { getEftMode, isEftAdmin, vendorInOwnerScope, mentionsEft } from '@/lib/eft'
import { withoutMerged } from '@/lib/merge'

// ── CONTENT-level wall (the read-side twin of notifyOwners' mentionsEft) ──────
//
// 2026-07-26: the rule moved from per-VENDOR to per-CONTENT. Owner alerts now
// reach both admins and withhold only bodies that talk about EFT, so reading had
// to match — otherwise the festival owner is pinged about a conversation and then
// 403s trying to open it. She can now open ANY vendor's thread; the individual
// messages that discuss EFT are what stay hidden.
//
// Same predicate as the alert side (mentionsEft), so the two cannot drift.

/** True when this viewer must not see EFT content. Only the EFT admin may. */
export function hidesEftContent(viewerEmail: string | null | undefined): boolean {
  return !isEftAdmin(viewerEmail)
}

/** Drop the messages that talk about EFT. `body` extracts the text to test, so
 *  one helper serves wa_messages, support_inbox_messages, mail_messages and the
 *  synthesised comms rows without each caller re-deriving the rule. */
export function stripEftMessages<T>(rows: T[] | null | undefined, body: (row: T) => unknown, hide: boolean): T[] {
  const list = rows || []
  if (!hide) return [...list]
  return list.filter((r) => {
    const t = body(r)
    return !mentionsEft(typeof t === 'string' ? t : null)
  })
}

/** Last 9 digits — the ZA subscriber number, stable across +27/0/local formats.
 *  Same canonical key the webhook and the unified inbox use (09ced95). */
export const phoneKey = (p: string | null | undefined): string => (p || '').replace(/\D/g, '').slice(-9)

export interface LaneVendorRow {
  id: string
  phone: string | null
  email: string | null
  admin_notes: string | null
  paid_at: string | null
}

export interface LaneScope {
  /** True when the viewer may read everything (the EFT admin). */
  unrestricted: boolean
  blocksPhone(phone: string | null | undefined): boolean
  blocksEmail(email: string | null | undefined): boolean
  blocksApplicationId(id: string | null | undefined): boolean
  /** Block if ANY supplied identifier resolves to a lane vendor. Identifiers are
   *  checked INDEPENDENTLY because a crafted request can mismatch them (a benign
   *  email paired with a lane vendor's phone). */
  blocks(x: { phone?: string | null; email?: string | null; applicationId?: string | null }): boolean
}

const ALLOW_ALL: LaneScope = {
  unrestricted: true,
  blocksPhone: () => false,
  blocksEmail: () => false,
  blocksApplicationId: () => false,
  blocks: () => false,
}

/** Pure core: build the scope from rows already loaded. Exported so the rule is
 *  unit-testable without Supabase. */
export function buildLaneScope(
  rows: LaneVendorRow[],
  globalOn: boolean,
  viewerIsEftAdmin: boolean,
): LaneScope {
  if (viewerIsEftAdmin) return ALLOW_ALL
  const phones = new Set<string>()
  const emails = new Set<string>()
  const ids = new Set<string>()
  for (const r of rows) {
    // 2026-07-26: blocks every vendor the festival owner does NOT own, which is
    // every unpaid one plus anyone settled by EFT or manual card — not merely the
    // "EFT lane" cohort. Taona: "samreen should never have access to unpaid
    // vendors except for when they sign up, sign contract". Those two moments are
    // ALERTS, not reads, so nothing here needs to carve them out.
    if (vendorInOwnerScope(r.admin_notes, r.paid_at)) continue
    ids.add(r.id)
    if (r.email) emails.add(r.email.toLowerCase())
    const k = phoneKey(r.phone)
    if (k) phones.add(k)
    // A vendor's WhatsApp-verified alternate number lives as a ⟦WAV<digits>⟧
    // marker on admin_notes, and threads arrive on it too. Without this the
    // alternate number is an unguarded door onto the same vendor.
    for (const m of (r.admin_notes || '').matchAll(/WAV(\d{6,})/g)) {
      const alt = phoneKey(m[1])
      if (alt) phones.add(alt)
    }
  }
  return {
    unrestricted: false,
    blocksPhone: (p) => { const k = phoneKey(p); return !!k && phones.has(k) },
    blocksEmail: (e) => !!e && emails.has(e.toLowerCase()),
    blocksApplicationId: (id) => !!id && ids.has(id),
    blocks(x) {
      return this.blocksPhone(x.phone) || this.blocksEmail(x.email) || this.blocksApplicationId(x.applicationId)
    },
  }
}

/** Load the lane scope for a viewer. One query per request; mirrors the select the
 *  unified inbox already runs. Fails CLOSED on a query error: an admin surface that
 *  cannot determine the lane must not fall back to showing everything. */
export async function laneScopeFor(viewerEmail: string | null | undefined): Promise<LaneScope> {
  if (isEftAdmin(viewerEmail)) return ALLOW_ALL
  const globalOn = await getEftMode()
  const { data, error } = await createAdminClient()
    .from('vendor_applications')
    .select('id, phone, email, admin_notes, paid_at')
    .limit(5000)
  if (error) {
    // Fail closed: block nothing-resolvable rather than expose the lane. Callers
    // treat a blocking scope as 403, which is the safe direction for a read.
    console.error('[inbox-lane] scope load failed, failing closed:', error.message)
    return {
      unrestricted: false,
      blocksPhone: () => true,
      blocksEmail: () => true,
      blocksApplicationId: () => true,
      blocks: () => true,
    }
  }
  // Merged duplicates carry the primary's identifiers but not its payment
  // state, so a stale subordinate could otherwise block (or expose) a vendor the
  // primary row governs. The primary decides.
  return buildLaneScope(withoutMerged(data as LaneVendorRow[]), globalOn, false)
}
