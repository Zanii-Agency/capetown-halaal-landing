import { isAcknowledgement } from '@/lib/bot/ack'

/**
 * Vendor WhatsApp Business auto-replies and away messages. These are not a
 * person asking for help, so they must not pin the thread as "waiting on a
 * person" or light the unread badge.
 *
 * Kept as loose regexes so one new auto-reply variant does not need a code
 * change. The patterns are conservative: if any of them match, the message is
 * treated as machine-generated and ignored for queue purposes.
 */
const AUTO_REPLY_RES = [
  // WhatsApp Business greeting auto-reply. It ALWAYS opens (optionally after a
  // short greeting like "Shukran/", "Salaam/Hi" or "Hi/Aslm") with "thank you
  // for contacting <their own business>". The tail is not fixed: real vendors'
  // greetings continue with "how we can help", "how we can assist", "how we can
  // be of assistance", "we are closed", a menu, opening hours, and so on. The
  // old pattern demanded the single tail "how we can help", so every other
  // ending (Frullato, MIZ DAYZEE, ~20 more) sailed through and pinned as
  // "waiting on a person". So match the OPENER, not the tail. The negative
  // lookahead keeps a genuine human ("thank you for contacting me/my ...") in
  // the queue: an auto-reply names the business or "us", never "me".
  /^[\s\S]{0,60}?\bthank\s*you for contacting (?!me\b|my\b)/i,
  /thank you for your message[\s\S]*?you have reached us outside our business hours/i,
  /you have reached us outside our business hours/i,
  /our whatsapp line is for customer support/i,
  /this is an automated (response|reply)/i,
  /we will get back to you as soon as possible/i,
  /we are currently (closed|offline|away)/i,
  /business hours/i,
]

/** True when the inbound text is a known WhatsApp Business auto-reply. */
export function isAutoReply(text: string | null | undefined): boolean {
  if (!text) return false
  return AUTO_REPLY_RES.some((re) => re.test(text))
}

/** Non-text inbound fallbacks the webhook writes into `body`. They carry no
 *  question and do not need a reply. */
const NON_TEXT_INBOUND = /^\s*(reacted\s|📍\s+shared\s+a\s+location|📇\s+shared\s+a\s+contact)/iu

/**
 * Should this inbound message count as "the vendor said something and we have
 * not answered yet"? Filters out:
 *   - empty/no-text rows
 *   - reactions, locations, contacts
 *   - WhatsApp Business auto-replies / away messages
 *   - acknowledgement closers ("ok", "thanks", "shukran", "👍")
 */
export function countsAsWaitingInbound(
  text: string | null | undefined,
  opts?: { hasMedia?: boolean }
): boolean {
  const raw = (text || '').trim()
  if (!raw && !opts?.hasMedia) return false
  if (NON_TEXT_INBOUND.test(raw)) return false
  if (isAutoReply(raw)) return false
  if (isAcknowledgement(raw)) return false
  return true
}
