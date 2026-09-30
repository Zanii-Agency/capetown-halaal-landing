// Split ONE email thread (support_inbox_threads is one row per address, UNIQUE
// peer_email, and DDL is blocked, Law 8) into separate CONVERSATIONS by subject,
// so "Payment plan" and "Vendor Whatsapp Group" read as two emails, not one
// (Taona 2026-09-23: "keep them separate"). Replies keep their subject ("Re: X"),
// so the normalised subject is the conversation key.
// zanii-codef: subject key, not the In-Reply-To chain. A reply whose subject was
// edited by the vendor lands in a new conversation; follow message_id/in_reply_to
// if that ever matters.
import type { CommItem } from './types'

const PREFIX_RE = /^\s*((re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i

/** "Re: RE: Fwd: Payment plan " -> "payment plan". Empty subject -> "". */
export function conversationKey(subject: string | null | undefined): string {
  return String(subject || '').replace(PREFIX_RE, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** The subject as a human reads it: prefixes stripped, original case. */
export function conversationTitle(subject: string | null | undefined): string {
  return String(subject || '').replace(PREFIX_RE, '').replace(/\s+/g, ' ').trim() || '(no subject)'
}

export interface EmailConversation { key: string; title: string; messages: CommItem[]; lastAt: string; autoOnly: boolean }

/** Split into conversations by subject, ALL ordered oldest-first by their latest
 *  message, so the whole thread reads in the order it happened (Taona 2026-09-24:
 *  "the sequence of messages should be as they happened, including automated").
 *
 *  A conversation made up ONLY of automated notices (reminders, confirmations) is
 *  no longer hoisted into a pool at the top — it keeps its own section in time
 *  order, flagged `autoOnly` so the view can render it collapsed. Automated
 *  messages inside a REAL conversation stay inline in that conversation's order. */
export function groupEmailConversations(messages: CommItem[]): { conversations: EmailConversation[] } {
  const byKey = new Map<string, EmailConversation>()
  for (const m of messages) {
    const key = conversationKey(m.subject)
    let c = byKey.get(key)
    if (!c) { c = { key, title: conversationTitle(m.subject), messages: [], lastAt: m.at, autoOnly: true }; byKey.set(key, c) }
    c.messages.push(m)
    if (m.at > c.lastAt) c.lastAt = m.at
  }
  const conversations = [...byKey.values()]
  for (const c of conversations) c.autoOnly = c.messages.every((m) => m.auto)
  conversations.sort((a, b) => (a.lastAt < b.lastAt ? -1 : 1))
  return { conversations }
}
