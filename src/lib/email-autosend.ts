// Auto-send gate for the email concierge.
//
// The concierge drafts a reply and asks Samreen to confirm SEND/SKIP. This gate
// decides, for the small subset that is safe, whether the draft may go out on
// its OWN with no human in the loop. Taona's bar (2026-08-18): "only when
// confidence is clear, and only if the response is the final proved solution,
// not 'a human will get back to you'."
//
// So the gate is deliberately strict and REFUSING by default. It only lets a
// draft auto-send when ALL hold:
//   1. The draft is a real, self-contained answer (not empty, not a stub).
//   2. It is NOT a deflection / holding reply. The drafter is explicitly told to
//      write "the team will look into it and follow up" when it cannot answer,
//      so this guard is the primary safety: any such reply is, by definition,
//      not a final solution and must go to a human.
//   3. It does not touch money, EFT, a payment arrangement, a refund, a proof of
//      payment, a dispute, a cancellation or an invoice. Anything with a Rand
//      consequence is a human's call, never the bot's.
//
// Flag EMAIL_AUTOSEND: 'off' (default, human-confirm everything, current
// behaviour), 'shadow' (compute the decision and LOG it, send nothing
// automatically, so we can SEE what it would send), 'on' (auto-send the
// eligible ones, human-confirm the rest).

export type AutoSendMode = 'off' | 'shadow' | 'on'
export function autoSendMode(): AutoSendMode {
  const v = (process.env.EMAIL_AUTOSEND || 'off').toLowerCase()
  return v === 'on' ? 'on' : v === 'shadow' ? 'shadow' : 'off'
}

// A reply that punts to a human. The drafter writes these verbatim when it can
// not answer, and they are precisely what must never auto-send.
const DEFLECTION = new RegExp(
  [
    'the team will', 'our team will', 'team will (get|look|be|follow|come|revert|confirm|check|review)',
    'get back to you', 'come back to you', 'revert to you', 'be in touch',
    'look(ing)? into (this|it|your)', 'following up (with|on)', 'follow up with (the|our) team',
    'flag(ged|ging)? (this|it|your|to)', 'escalat', 'raise(d|) (this|it) (with|to)',
    'a (human|team member|colleague|person)', 'someone (from (the|our) team )?will',
    'reach out to you', 'pass(ed|ing)? (this|your|it) (on|to|along)', 'forward(ed|ing)? (this|your)',
    'checking with (the|our) team', 'we will (look|check|confirm|get|be|follow|come)',
    'will (get|come) back', 'will let you know', 'once we (have|hear)',
  ].join('|'),
  'i',
)

// The draft recognises the email is NOT a real vendor query: a system alert
// bouncing back, spam, a misdirected message. The shadow caught the concierge
// drafting "this appears to be a system notification" replies to [YAH] system
// alerts and courier spam, which must never auto-send. If the draft says the
// message is not for us / cannot be actioned / is a notification, hold it.
const NOT_A_QUERY = new RegExp(
  [
    'appears? to be (a )?(system|security|automated)', 'this (is|looks like) (a|an) (system|security|automated|notification)',
    '(system|security|automated) notification', 'not (intended|meant) for (us|the festival)',
    'does(n\'?t| not) (handle|deal with)', 'not able to action', 'can(no|\')?t action',
    'rather than a (message|request|reply)', 'there (may|might) be some confusion',
    'sent to (us|an email address)', 'not sure this (message|was)', 'we think there may be',
    'meant for (someone|a different|another)', 'seems to have been sent', 'this notification',
  ].join('|'),
  'i',
)

// Anything with a money / payment consequence: a human decides, never the gate.
const SENSITIVE = new RegExp(
  [
    'payment plan', 'instal?ment', 'deposit', 'part[- ]?payment', 'pay half', '50/50', '50%',
    'extension', 'extend', 'more time', 'defer', 'until (end of|the) ',
    'refund', 'proof of payment', '\\bpop\\b', 'bank(ing)?', '\\beft\\b', 'account (number|details)',
    'dispute', 'overcharg', 'wrong amount', 'incorrect (amount|fee|price)', 'charged',
    'cancel', 'withdraw', 'pull(ing)? out', 'no longer',
    'invoice', 'vat', 'discount', 'cheaper', 'reduce', 'waive',
  ].join('|'),
  'i',
)

export interface AutoSendDecision {
  auto: boolean
  reason: string
}

/** Decide whether this drafted reply may auto-send. Pure + testable.
 *  `fromIsVendor` MUST be true (the sender resolves to a real vendor row). This
 *  is the hard gate that kills spam, B2B pitches and the festival's own [YAH]
 *  system alerts bouncing back: none of those are vendors, so the bot never
 *  auto-replies to them. Content regex alone could not catch every phrasing. */
export function autoSendDecision(
  emailText: string,
  draft: string | null | undefined,
  opts: { fromIsVendor: boolean },
): AutoSendDecision {
  if (!opts.fromIsVendor) return { auto: false, reason: 'sender is not a known vendor (spam / system alert / B2B)' }
  const d = (draft || '').trim()
  if (d.length < 40) return { auto: false, reason: 'draft too short or empty' }
  if (DEFLECTION.test(d)) return { auto: false, reason: 'deflection / holding reply (not a final solution)' }
  if (NOT_A_QUERY.test(d)) return { auto: false, reason: 'not a real vendor query (system alert / spam / misdirected)' }
  const haystack = `${emailText || ''}\n${d}`
  if (SENSITIVE.test(haystack)) return { auto: false, reason: 'touches money / EFT / arrangement (human decides)' }
  return { auto: true, reason: 'self-contained final answer, no money consequence' }
}
