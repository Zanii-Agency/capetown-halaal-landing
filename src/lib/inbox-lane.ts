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
import { getEftMode, isEftAdmin, vendorInOwnerScope, revealsPaymentArrangement } from '@/lib/eft'
import { isMasterOnlySender } from '@/lib/master-only-senders'
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
    return !revealsPaymentArrangement(typeof t === 'string' ? t : null)
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
  /** Unapproved applicants are never lane-gated: no payment lane exists yet. */
  status?: string | null
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
    // UNAPPROVED applicants are hers (Taona 2026-07-27: "samreen must be able to
    // see all emails and messages from unapproved vendors"). They have no
    // payment lane yet, so there is nothing about the EFT arrangement to leak,
    // and they are exactly the people asking the questions she answers.
    // `r.status &&` IS DELIBERATE. DO NOT "FIX" IT TO `(r.status || 'pending')`.
    //
    // It reads like an oversight — a NULL status skips the check, falls through
    // to the payment test, and gets blocked, so an unapproved applicant with no
    // status is hidden from Samreen rather than shown. A reviewer (and, on
    // 2026-07-28, an analysis agent) will call that the opposite of this line's
    // purpose and propose defaulting the status to 'pending'.
    //
    // That change BREACHES THE SEAL. This same line is the wall in front of
    // EFT-lane vendors. Default an absent status to 'pending' and every vendor
    // whose status is NULL — including one carrying ⟦EFT⟧ — takes the `continue`
    // and never enters the blocked set, so the festival owner can reach their
    // messages by phone, email or application id. Three tests in
    // inbox-lane.test.ts fail the moment you try it; that is them working.
    //
    // The widening this line exists for is for REAL applicants, who have a real
    // status: the schema defaults it to 'pending' and the public insert omits
    // it, so 'pending' is what they actually carry. NULL is not a pending
    // applicant, it is a row nobody can classify — and an unclassifiable row
    // must fail CLOSED, because the cost of being wrong is asymmetric: hiding a
    // generic sender is an inconvenience, exposing an EFT vendor's payment
    // conversation is the breach this whole module was built to prevent.
    if (r.status && r.status !== 'approved') continue
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
    // THE SENDER RULE LIVES HERE, NOT IN EACH READER.
    //
    // It was first added to loadMailThreads only, which sealed the three
    // /admin/inbox/* workspaces and nothing else. The festival owner was reading
    // ABSA and Standard Bank payment notices on /admin/support-inbox, a
    // different page with its own endpoint, hours after I had "fixed" it and
    // verified the fix against the loader I had changed.
    //
    // An audit of every endpoint touching support_inbox_* / wa_messages found 23
    // of them, 13 already calling scope.blocks and NONE checking the sender.
    // Patching 13 readers is how the fourteenth gets missed. Putting it in the
    // scope means every existing caller inherits it and every future one does
    // too, which is the same reason the vendor seal lives in this module rather
    // than in the handlers.
    blocksEmail: (e) => !!e && (emails.has(e.toLowerCase()) || isMasterOnlySender(e)),
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

  const shut = (why: string): LaneScope => {
    console.error(`[inbox-lane] scope load failed, failing closed: ${why}`)
    return {
      unrestricted: false,
      blocksPhone: () => true,
      blocksEmail: () => true,
      blocksApplicationId: () => true,
      blocks: () => true,
    }
  }

  // PAGE, AND PROVE THE PAGING WAS COMPLETE.
  //
  // This was `.limit(5000)`, which PostgREST silently truncates to 1000 on this
  // project (db-max-rows) — the same truncation both thread loaders were
  // rewritten to kill. Here it was far worse than a short list. buildLaneScope
  // returns a membership test over BLOCKED vendors, so a vendor truncated away
  // is indistinguishable from a vendor who was never in the lane: blocks()
  // returns false and they become readable by the festival owner on every
  // channel and every sealed endpoint at once. The seal failed OPEN.
  //
  // The error branch below could not save it either, because a max-rows
  // truncation is HTTP 206, not an error, so `error` is null and the fail-closed
  // path never fired. Hence the explicit count check: a wall that cannot prove it
  // saw every row must refuse to answer "not blocked".
  const db = createAdminClient()
  const rows: LaneVendorRow[] = []
  const PAGE = 1000
  let total: number | null = null

  for (let page = 0; page < 25; page++) {
    const from = page * PAGE
    const { data, error, count } = await db
      .from('vendor_applications')
      .select('id, phone, email, admin_notes, paid_at, status', { count: 'exact' })
      .order('id', { ascending: true })   // stable order, or pages overlap and skip
      .range(from, from + PAGE - 1)
    if (error) return shut(error.message)
    if (count !== null) total = count
    rows.push(...((data || []) as LaneVendorRow[]))
    if (!data || data.length < PAGE) break
  }

  if (total !== null && rows.length < total) {
    return shut(`loaded ${rows.length} of ${total} vendor rows; refusing to seal on a partial set`)
  }
  // Merged duplicates carry the primary's identifiers but not its payment
  // state, so a stale subordinate could otherwise block (or expose) a vendor the
  // primary row governs. The primary decides.
  return buildLaneScope(withoutMerged(rows), globalOn, false)
}
