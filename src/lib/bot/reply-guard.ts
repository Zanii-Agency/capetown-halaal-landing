/**
 * Bot reply guard — output-side PII filter.
 *
 * KT #114 pattern: defenses on OUTPUT not just INPUT. The festival LLM might
 * be tricked or might hallucinate someone else's phone/email/ID. Before any
 * reply leaves sendText(), pass it through this filter:
 *  - Redact any phone/email/ID that does NOT belong to the caller.
 *  - Replace with a neutral placeholder + log the redaction to site_events
 *    so we can review attack attempts.
 *
 * Allowlist = the caller's own contact data, derived from ResolvedIdentity.
 * Everything else gets [redacted].
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ResolvedIdentity } from '@/lib/bot/identity'
import { guardBankingTalk } from '@/lib/bot/banking-guard'

// E.164 SA + international shapes + local SA dialing.
const PHONE_PATTERNS: RegExp[] = [
  /\+\d{8,15}\b/g,            // +27123456789, +971501168462
  /\b0\d{8,10}\b/g,           // 0721234567 (SA local)
  /\b\d{3}\s?\d{3}\s?\d{4}\b/g, // 555 123 4567
]
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// SA ID number = 13 digits, optionally with spaces/dashes.
const SA_ID_PATTERN = /\b\d{6}[\s\-]?\d{4}[\s\-]?\d{3}\b/g

export interface ReplyGuardOpts {
  identity: ResolvedIdentity
  callerE164: string
}

export interface GuardedReply {
  reply: string
  redactionCount: number
  reasons: string[]
}

function normalizePhone(s: string): string {
  return s.replace(/[\s\-\(\)]/g, '').replace(/^00/, '+').replace(/^0(\d)/, '+27$1')
}

function callerAllowlist(opts: ReplyGuardOpts): { phones: Set<string>; emails: Set<string> } {
  const phones = new Set<string>()
  const emails = new Set<string>()
  // Caller's own inbound number is always allowed.
  phones.add(normalizePhone(opts.callerE164))
  phones.add(opts.callerE164)
  const { identity } = opts
  if (identity.role === 'admin' && identity.admin) {
    phones.add(normalizePhone(identity.admin.phone))
    phones.add(identity.admin.phone)
    if (identity.admin.email) emails.add(identity.admin.email.toLowerCase())
  }
  if (identity.role === 'vendor' && identity.vendor?.email) {
    emails.add(identity.vendor.email.toLowerCase())
  }
  if (identity.role === 'ticket_buyer' && identity.buyer?.email) {
    emails.add(identity.buyer.email.toLowerCase())
  }
  // Always allow the public support channels (system prompt teaches them).
  emails.add('support@youngatheart.co.za')
  emails.add('capetownhalaal@gmail.com')
  phones.add(normalizePhone('+27659435012'))
  phones.add('0659435012')
  return { phones, emails }
}

export function guardReply(reply: string, opts: ReplyGuardOpts): GuardedReply {
  if (!reply) return { reply: '', redactionCount: 0, reasons: [] }

  // BANKING: the bot does not discuss it with a vendor, at all. Handled here
  // because this is the single chokepoint every bot reply already passes
  // through, so there is no second path to remember. Admins are exempt: the
  // master brain answering Taona about the account is a different conversation
  // from the bot answering a vendor, and only the second one is the risk.
  if (opts.identity.role !== 'admin') {
    const banking = guardBankingTalk(reply)
    if (banking.replaced) {
      return { reply: banking.reply, redactionCount: 1, reasons: ['banking_talk_replaced'] }
    }
  }
  const { phones, emails } = callerAllowlist(opts)
  let count = 0
  const reasons: string[] = []
  let out = reply

  // Email
  out = out.replace(EMAIL_PATTERN, (m) => {
    if (emails.has(m.toLowerCase())) return m
    count++
    reasons.push(`email:${m}`)
    return '[email redacted]'
  })

  // SA ID
  out = out.replace(SA_ID_PATTERN, (m) => {
    count++
    reasons.push('sa_id')
    return '[id redacted]'
  })

  // Phones — apply all patterns
  for (const pat of PHONE_PATTERNS) {
    out = out.replace(pat, (m) => {
      const norm = normalizePhone(m)
      if (phones.has(norm) || phones.has(m)) return m
      count++
      reasons.push(`phone:${m}`)
      return '[phone redacted]'
    })
  }

  return { reply: out, redactionCount: count, reasons }
}

/**
 * Log a guard event to site_events. Best-effort, never throws.
 */
export async function logGuardRedaction(opts: {
  callerE164: string
  role: string
  redactionCount: number
  reasons: string[]
  originalLen: number
}): Promise<void> {
  if (opts.redactionCount === 0) return
  try {
    const db = createAdminClient()
    await db.from('site_events').insert({
      session_id: 'bot_reply_guard',
      event_type: 'bot_reply_redacted',
      path: '/api/whatsapp/webhook',
      metadata: {
        caller: opts.callerE164,
        role: opts.role,
        count: opts.redactionCount,
        reasons: opts.reasons.slice(0, 20),
        original_len: opts.originalLen,
      },
    })
  } catch {
    // silent
  }
}
