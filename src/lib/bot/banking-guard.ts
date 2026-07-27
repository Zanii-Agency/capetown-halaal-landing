/**
 * The bot does not discuss banking. Ever.
 *
 * Taona, 2026-07-27, after the bot told a vendor "your banking details for the
 * stall fee are already available now ... you'll see the amount and account
 * details there": "no mention of banking details, just tell them to go to the
 * portal and rock from there."
 *
 * WHY THIS IS A REPLACEMENT AND NOT A REDACTION. The sibling PII guard blanks
 * individual tokens, which works for a phone number sitting in a sentence. Do
 * that to banking language and you get "your [redacted] are already available",
 * which is worse than the original: it reads as though something was hidden from
 * the vendor. Banking talk is not a token to excise, it is a topic the bot must
 * not be on, so the whole reply is swapped for the one line that is always true
 * and always safe.
 *
 * WHY NOT A PROMPT RULE. Twice today a prompt rule failed to hold: the "no
 * closing question" instruction was already in the system prompt when the bot
 * asked a vendor what she was celebrating, and the payment-outage rule was in
 * place before it told another vendor the gateway was down. A model asked to
 * be helpful about payment will explain payment. The portal is the single source
 * of banking truth, and the ONLY way to guarantee the bot never contradicts it,
 * never quotes a stale account number, and never becomes a phishing rehearsal is
 * to make the sentence impossible rather than discouraged.
 *
 * This matters more than it did yesterday: the receiving account number changed
 * on 2026-07-27. Anything the bot ever said about "account details" is now a
 * chance to be confidently wrong.
 */

/** The one thing the bot may say about paying. */
export const PORTAL_PAYMENT_LINE =
  'Everything for your stall fee is in your portal. Log in at cthalaal.co.za/exhibitor/login and open Payments, and it is all there ready for you.'

// Topic words, not value patterns: the bot never HAD the real numbers, it talked
// ABOUT them, so matching digits alone would miss every real case.
const BANKING_TERMS = [
  /\bbank(?:ing)?\s+(?:details?|info(?:rmation)?|account)\b/i,
  /\baccount\s+(?:details?|number|name|no\b)/i,
  /\bbranch\s+code\b/i,
  /\bbeneficiary\b/i,
  /\b(?:iban|swift|bic)\b/i,
  /\bproof\s+of\s+payment\s+to\s+the\s+account\b/i,
  /\bpay\s+(?:in)?to\s+(?:the\s+)?account\b/i,
  /\bdeposit\s+(?:in)?to\b/i,
  /\bFNB\b/,
  /\bcheque\s+account\b/i,
  /\bsavings\s+account\b/i,
]

// A bare account-number-shaped run, in case a future path ever hands the bot the
// real thing. 9-13 digits with optional spacing, not attached to a phone shape.
const ACCOUNT_NUMBER_SHAPE = /(?<![+\d])\d{2}[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2,4}(?![\d])/

export function mentionsBanking(text: string | null | undefined): boolean {
  const s = (text || '').trim()
  if (!s) return false
  if (BANKING_TERMS.some((re) => re.test(s))) return true
  // Only treat a digit run as an account number when the sentence is about
  // paying, so an order reference or a stall count is never swallowed.
  if (/\b(pay|payment|transfer|eft|deposit|fee)\b/i.test(s) && ACCOUNT_NUMBER_SHAPE.test(s)) return true
  return false
}

export interface BankingGuardResult {
  reply: string
  replaced: boolean
}

/**
 * Swap any banking talk for the portal line. Returns the reply unchanged when
 * it was already clean, so the common path costs one regex sweep.
 */
export function guardBankingTalk(reply: string): BankingGuardResult {
  if (!mentionsBanking(reply)) return { reply, replaced: false }
  return { reply: PORTAL_PAYMENT_LINE, replaced: true }
}
