// Auto-reply to WITHDRAWAL emails: detect a vendor pulling out, withdraw them,
// and send ONE clean confirmation. No money talk, no plan offer, no invoice.
//
// Taona 2026-09-11 (verbatim): "when someone requests to withdraw once they have
// already mentioned the reason, please just withdraw them... don't say anything
// [about payment] to them, just email that withdrawal has been completed and
// remove them." Two vendors had quit (Treacle and Tart: car accident, "I do not
// want to hold onto the space"; Wokness monster: restructure, "we decided to
// withdraw from all events") and the plan / invoice autorepliers replied with
// MONEY talk because neither of those checked for a withdrawal first. A
// withdrawal email must win over every money-intent reply, so this runs FIRST in
// the email-concierge cron, before plan and invoice.
//
// The trigger is matched ONLY against the sender's OWN text (stripQuotedReply):
// a forwarded chain or the festival's own footer must never read as a withdrawal
// (same rule as the proof detector, maspark 2026-09-07). A negative gate on
// payment-plan keywords keeps "I'd love to come but can't pay this month" a plan
// request, not a withdrawal.
//
// Money rule: an UNPAID vendor who stated their reason is withdrawn on the spot
// (no refund question). A PAID vendor is never auto-withdrawn (withdrawApplication
// refuses); they are left for a human because the money needs a refund decision.
// A withdrawal with no reason given is left for a human to ask why, exactly as
// the bot does (Taona 2026-07-29: ask why if not mentioned).

import type { createAdminClient } from '@/lib/supabase/admin'
import { rowToEmail, sendEmailReply } from '@/lib/email-concierge'
import { resolveVendorForEmail } from '@/lib/payments/email-proof-intake'
import { stripQuotedReply } from '@/lib/payments/email-proof-detect'
import { hasPaid } from '@/lib/portal-state'
import { parsePortalState } from '@/lib/portal-state'
import { withdrawApplication } from '@/lib/vendors/withdraw'

type Db = ReturnType<typeof createAdminClient>

// Genuine "we are pulling out" phrasing. Plain text (node:test runs the source),
// matched against the sender's OWN text only. Presence of ONE of these = quit intent.
const WITHDRAW_RE = new RegExp(
  [
    '\\bwithdraw', '\\bpull(ing)? out\\b', '\\bcancel(l?ing)? (my|our|the)',
    "no longer (able|participat|join|be|commit)",
    "(can|could)('?t| not) (commit|make it|participate|be there|take part)",
    'unable to (fully )?(commit|participate|make it)',
    'release (my|our|the) (stall|slot|space|stand|booth)',
    'give up (my|our|the) (stall|slot|space)',
    "decided to (withdraw|pull out|step back)",
    'from all events', "won'?t be (able to )?(participat|mak(e|ing) it|joining|attend)",
    'hold ?on ?to (the |my |our )?(space|stall|slot)',
    'if someone else (is able|can|wants)',
  ].join('|'),
  'i',
)

// "I'd love to come, but I can't pay this month" mentions quitting-adjacent money
// words yet is a STAY request. It only overrides a quit when there is NO explicit
// quit phrase AND the sender is clearly still trying to come (asks for a plan /
// extension / more time as the way to make it work).
const STAY_RE = /(would love|really want|keen|hope) to (come|be part|join|participate)|payment\s*plan|instal?ments?|pay (it )?(off|over time|in parts|monthly)|more time to pay|pay a deposit|\barrange\b/i

/** True when the email is a vendor pulling out, on the sender's OWN text. */
export function isWithdrawalEmail(subject: string | null | undefined, body: string | null | undefined): boolean {
  const text = `${subject || ''}\n${stripQuotedReply(body || '')}`
  if (!WITHDRAW_RE.test(text)) return false
  // An EXPLICIT quit always wins, even if money words are present (Treacle and
  // Tart mentioned "the requested payment plan" while withdrawing). The stay
  // gate only rescues an AMBIGUOUS email: quit-adjacent words but no real quit.
  const explicitQuit = /\bwithdraw|\bpull(ing)? out\b|\bcancel(l?ing)? (my|our|the)|decided to (withdraw|pull out)|no longer (able|participat)|give up (my|our|the)|release (my|our|the)|from all events|hold ?on ?to (the |my |our )?(space|stall|slot)/i.test(text)
  if (explicitQuit) return true
  // Ambiguous: "can't commit / make it / participate". A clear desire to STAY and
  // pay differently means it is a plan request, not a withdrawal.
  if (STAY_RE.test(text)) return false
  return true
}

const AUTO = 'auto_replied_withdrawal'

export function withdrawalConfirmText(firstName: string, business: string): string {
  const first = (firstName || 'there').trim() || 'there'
  const biz = (business || 'your stall').trim()
  return [
    `Salaam ${first},`,
    '',
    `We are sorry to hear this, but we understand. We have withdrawn ${biz} from the Young at Heart Festival 2026 and released your stall.`,
    '',
    'There is nothing more you need to do. If you change your mind, or would like to join us again next year, you are very welcome to apply again.',
    '',
    'Jazakallah khair,',
    'The Young at Heart Festival Team',
  ].join('\n')
}

/** Scan NEW inbound for withdrawal emails from resolvable vendors and act. Runs
 *  FIRST in the cron so a quit never reaches the plan/invoice autorepliers.
 *  Best-effort: never throws into the cron. */
export async function runWithdrawalAutoReplies(db: Db): Promise<{ withdrawn: number; skipped: number; errors: string[] }> {
  const out = { withdrawn: 0, skipped: 0, errors: [] as string[] }
  try {
    const { data: rows } = await db
      .from('support_inbox_messages')
      .select('id, thread_id, from_address, from_name, to_address, subject, body_text, message_id, mailbox, direction, concierge_status, received_at')
      .is('concierge_status', null)
      .eq('direction', 'in')
      .order('received_at', { ascending: true })
      .limit(50)

    for (const m of rows || []) {
      const from = String(m.from_address || '').toLowerCase()
      if (!from) continue
      if (!isWithdrawalEmail(m.subject as string, m.body_text as string)) continue

      const vendor = await resolveVendorForEmail(db, from, null)
      if (!vendor) continue

      // One withdrawal action per thread. A follow-up on an already-handled
      // thread is marked so it exits the NULL pool for a human.
      const { data: prior } = await db
        .from('support_inbox_messages')
        .select('id')
        .eq('thread_id', m.thread_id as string)
        .eq('concierge_status', AUTO)
        .limit(1)
      if (prior && prior.length) {
        await db.from('support_inbox_messages').update({ concierge_status: 'skipped' }).eq('id', m.id as string)
        out.skipped += 1
        continue
      }

      const first = String(vendor.contact_name || m.from_name || 'there').trim().split(/\s+/)[0] || 'there'

      // PAID vendor: never auto-withdraw (a refund is a human decision). Leave
      // for a human by marking skipped so the money is never auto-replied.
      if (vendor.paid_at || hasPaid(parsePortalState(vendor.admin_notes || ''))) {
        await db.from('support_inbox_messages').update({ concierge_status: 'skipped' }).eq('id', m.id as string)
        out.skipped += 1
        continue
      }

      // They quit in their own words (WITHDRAW_RE already gated this email on a
      // quit keyword). Withdraw now and confirm. Record their "because/due to"
      // text as the reason when present; otherwise a one-line generic reason.
      const ownText = stripQuotedReply(String(m.body_text || ''))
      const statedReason = (ownText.match(/because[^.\n]{3,200}|due to[^.\n]{3,200}/i)?.[0] || '').trim().slice(0, 200)

      const w = await withdrawApplication(db, {
        applicationId: vendor.id,
        reason: statedReason || 'withdrawn via email',
        actorEmail: 'withdrawal-email-autoreply',
        actorRole: 'system',
      })
      if (!w.ok) {
        // already_withdrawn / not_found: mark so it stops re-firing; a human sees it.
        await db.from('support_inbox_messages').update({ concierge_status: 'skipped' }).eq('id', m.id as string)
        out.skipped += 1
        continue
      }

      const text = withdrawalConfirmText(first, w.businessName)
      const res = await sendEmailReply(rowToEmail(m as Record<string, unknown>), text)
      if (res.ok) {
        await db.from('support_inbox_messages').update({ concierge_status: AUTO, concierge_draft: text }).eq('id', m.id as string)
        out.withdrawn += 1
      } else {
        out.errors.push(`${from}: withdrawn but confirm email failed: ${res.error}`)
      }
    }
  } catch (e) {
    out.errors.push((e as Error).message)
  }
  return out
}
