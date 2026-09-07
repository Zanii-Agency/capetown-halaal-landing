// Auto-reply to payment-plan / arrangement emails and push them to WhatsApp.
//
// Taona 2026-09-07: "anyone that wants a payment plan must send a message to
// WhatsApp, provide the number, and make sure the plan emails are auto replied
// to and pushed to WhatsApp." Plans are set up by the WhatsApp assistant (which
// confirms the exact dates on the spot); email is not the place to negotiate
// them. So a plan-request email gets ONE automatic reply directing the vendor to
// WhatsApp, and is then marked handled so the draft-confirm concierge skips it.
//
// Runs inside the email-concierge cron (every 2 min), BEFORE its own flag gate,
// so it works even when the draft-confirm concierge is off. Idempotent per
// thread: one auto-reply, never a loop.

import type { createAdminClient } from '@/lib/supabase/admin'
import { rowToEmail, sendEmailReply } from '@/lib/email-concierge'
import { resolveVendorForEmail } from '@/lib/payments/email-proof-intake'
import { parsePortalState } from '@/lib/portal-state'

type Db = ReturnType<typeof createAdminClient>

const WHATSAPP_NUMBER = '+27 65 943 5012'
const WHATSAPP_LINK = 'wa.me/27659435012'

// A genuine request to pay in parts / arrange / defer. Deliberately gated at the
// call site to a RESOLVED, UNPAID vendor, so a plain word like "arrangement" in a
// supplier quote can never trigger it.
const PLAN_RE = new RegExp(
  [
    'payment\\s*plan', '\\barrange', 'part\\s*payment', 'in\\s*\\d+\\s*parts?',
    'pay\\s*(it\\s*)?(off|in\\s*(parts|bits|stages|instal?ments?))',
    '\\binstal?ments?\\b', '\\bdeposit\\b', 'half\\s*now', '(a|the)\\s*portion',
    "can'?t\\s*afford", 'cannot\\s*afford', 'afford\\s*the\\s*full',
    'more\\s*time\\s*to\\s*pay', 'pay\\s*monthly', 'pay\\s*(it\\s*)?over\\s*time',
    'split\\s*(the\\s*)?(payment|fee|amount|cost)', 'lay(-|\\s)?bye', 'laybye',
    'pay\\s*(a\\s*)?(bit|little|part)\\s*(now|first)',
  ].join('|'),
  'i',
)

export function isPlanRequestEmail(subject: string | null | undefined, body: string | null | undefined): boolean {
  return PLAN_RE.test(`${subject || ''}\n${body || ''}`)
}

export function planAutoReplyText(firstName: string, business: string): string {
  const first = (firstName || 'there').trim() || 'there'
  const biz = (business || 'your stall').trim()
  return [
    `Salaam ${first},`,
    '',
    `Thank you for reaching out about a payment plan for ${biz}. We would love to help.`,
    '',
    'If you can, settling the full stall fee by the end of September is best, because paying earlier genuinely helps us lock in the marquee, power and marketing and put on the best possible show for you.',
    '',
    `If a single payment this month is not possible, we arrange payment plans over WhatsApp so we can confirm the exact dates with you on the spot. Please message us on WhatsApp on ${WHATSAPP_NUMBER} (or tap ${WHATSAPP_LINK}) and our assistant will set up your plan right away.`,
    '',
    'Jazakallah khair,',
    'The Young at Heart Festival Team',
  ].join('\n')
}

const AUTO = 'auto_replied_plan'

/** Scan NEW inbound (concierge_status IS NULL) for plan-request emails from
 *  resolvable unpaid vendors, auto-reply once per thread, and mark them handled.
 *  Best-effort: never throws into the cron. */
export async function runPlanAutoReplies(db: Db): Promise<{ replied: number; skipped: number; errors: string[] }> {
  const out = { replied: 0, skipped: 0, errors: [] as string[] }
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
      if (!isPlanRequestEmail(m.subject as string, m.body_text as string)) continue

      // Resolve to a real, UNPAID vendor. A supplier or ticket buyer never
      // resolves, so they are left for the normal concierge flow untouched.
      const vendor = await resolveVendorForEmail(db, from, null)
      if (!vendor || vendor.paid_at) { continue }

      // Already on an approved plan: they are sorted, so do not push them to
      // WhatsApp again. Leave the email for a human (mark skipped).
      const arr = parsePortalState(vendor.admin_notes || '').payment?.arrangement
      if (arr?.plan_status === 'approved' && (arr.installments?.length ?? 0) > 0) {
        await db.from('support_inbox_messages').update({ concierge_status: 'skipped' }).eq('id', m.id as string)
        out.skipped += 1
        continue
      }

      // One auto-reply per thread. If this thread already got the WhatsApp push,
      // leave this follow-up for a human (mark skipped so it exits the NULL pool).
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
      const text = planAutoReplyText(first, String(vendor.business_name || 'your stall'))
      const res = await sendEmailReply(rowToEmail(m as Record<string, unknown>), text)
      if (res.ok) {
        await db.from('support_inbox_messages').update({ concierge_status: AUTO, concierge_draft: text }).eq('id', m.id as string)
        out.replied += 1
      } else {
        out.errors.push(`${from}: ${res.error}`)
      }
    }
  } catch (e) {
    out.errors.push((e as Error).message)
  }
  return out
}
