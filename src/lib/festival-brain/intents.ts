/**
 * Intent classification for inbound festival messages.
 *
 * Two-pass design:
 *   1. Fast regex / keyword scoring (always runs, deterministic, free).
 *   2. Optional LLM classifier fallback (brain-core classifyIntent) when score is ambiguous.
 *
 * Returns { intent, confidence, reason } so the brain layer can decide:
 *   - high confidence + FAQ match  => canonical answer
 *   - low confidence               => escalate to human
 *   - medium                       => LLM with grounding
 */

export type Intent =
  | 'ticket_buyer'
  | 'vendor_application'
  | 'vendor_status'
  | 'vendor_docs'
  | 'vendor_payment'
  | 'sponsorship'
  | 'general_inquiry'
  | 'human_request'
  | 'spam'

export interface IntentResult {
  intent: Intent
  confidence: number // 0..1
  reason: string
}

interface IntentRule {
  intent: Intent
  patterns: RegExp[]
  weight: number
}

const RULES: IntentRule[] = [
  // ticket_buyer
  {
    intent: 'ticket_buyer',
    weight: 1,
    patterns: [
      /\b(buy|purchase|get|book|reserve) (a |my |the )?ticket/i,
      /\bticket (price|cost|link|url|where)\b/i,
      /\bhow much.*(ticket|entry|gate)\b/i,
      /\b(weekend pass|day pass|rider ticket)\b/i,
      /\b(kids?|child(ren)?)\b.{0,25}\b(ticket|free|enter|pay)\b/i,
      // Ticket-buyer FAQ shapes: refund, fees, payment, gift, types, exchange,
      // transfer, delivery, entry, accessibility, collection, scan. These let the
      // intent reach >=0.55 so the FAQ short-circuit serves the canonical answer.
      /\brefund\b/i,
      /\b(event|festival)\b.{0,25}\bcancel/i,
      /\b(booking|extra|hidden|service)\s*fees?\b/i,
      /\b(payment|pay)\b.{0,15}\b(method|option|card|cash|accept)\b/i,
      /\b(visa|mastercard)\b/i,
      /\bgift\b.{0,20}\bticket/i,
      /\bticket.{0,20}\bgift\b/i,
      /\bticket.{0,15}\b(type|kind|option)/i,
      /\b(type|kind|option)s?\b.{0,15}\bticket/i,
      /\b(exchange|transfer)\b.{0,15}\bticket/i,
      /\bticket.{0,15}\b(exchange|transfer)/i,
      /\b(e[\s-]?ticket|pdf)\b/i,
      /\b(receive|collect|scan)\b.{0,15}\bticket/i,
      /\bticket.{0,15}\b(scan|collect|pick ?up)/i,
      /\b(wheelchair|accessible|accessibility|mobility|disabled|disability)\b/i,
      /\bwhat\b.{0,20}\bbring\b/i,
    ],
  },
  // vendor_application
  {
    intent: 'vendor_application',
    weight: 1,
    patterns: [
      /\b(become|apply|sign up|register).*(vendor|stall|booth|exhibitor|trader)\b/i,
      /\bhow (do|can) i (become a vendor|apply|get a stall|get a booth)\b/i,
      /\bi want (a |to have a )?(stall|booth|stand|table)\b/i,
      /\bvendor (form|application|apply)\b/i,
    ],
  },
  // vendor_status
  {
    intent: 'vendor_status',
    weight: 1,
    patterns: [
      /\b(my )?(application|status|approved|rejected|accepted|confirm(ed|ation))\b/i,
      /\bdid (you |we )?(get|receive|approve) (my|the) (application|form)\b/i,
      /\b(any )?update.*(application|stall|booth)\b/i,
      /\bwhen will i (hear|know|get a reply)\b/i,
    ],
  },
  // vendor_docs
  {
    intent: 'vendor_docs',
    weight: 1,
    patterns: [
      /\b(certificate|cert|halaal cert|mjc|sanha)\b/i,
      /\b(upload|send|submit|need).*(document|paperwork|certif)\b/i,
      /\b(public liability|insurance|coid|tax clearance)\b/i,
      /\b(id|identity|company reg)\b/i,
    ],
  },
  // vendor_payment
  {
    intent: 'vendor_payment',
    weight: 1,
    patterns: [
      /\b(pay|paid|payment|invoice|deposit|eft|bank|transfer)\b/i,
      /\b(banking details|account number|swift)\b/i,
      /\b(stall|booth|electricity).*(fee|cost|paid|payment)\b/i,
      /\bproof of payment\b/i,
    ],
  },
  // sponsorship
  {
    intent: 'sponsorship',
    weight: 1,
    patterns: [
      /\b(sponsor|sponsorship|partner|partnership|media partner|brand activation)\b/i,
      /\b(my brand|our brand|our company).*(activation|exposure|reach)\b/i,
      /\bsponsorship pack(age)?\b/i,
    ],
  },
  // human_request
  {
    intent: 'human_request',
    weight: 1.5, // user explicitly asks for a person, prioritise
    patterns: [
      /\b(speak|talk|chat).*(human|person|someone|samreen|the team|manager|organiser|organizer)\b/i,
      /\bi (want|need|would like) to (speak|talk) to\b/i,
      /\bcan (you )?(connect|put) me (with|through)\b/i,
      /\bnot a bot\b/i,
      /\bi want a (human|person|real)\b/i,
    ],
  },
  // spam
  {
    intent: 'spam',
    weight: 1.2,
    patterns: [
      /\b(crypto|invest(ment)?|forex|trading bot|btc|bitcoin)\b/i,
      /\bhttps?:\/\/(bit\.ly|tinyurl|goo\.gl)\b/i,
      /\bclick (here|the link) to (claim|win|earn)\b/i,
      /\bwhatsapp \+?\d{6,}/i,
      /\bonly\s+legit\b/i,
    ],
  },
]

/**
 * Local fast classifier. Always runs first.
 */
export function classifyIntent(message: string): IntentResult {
  const text = message.trim()

  if (!text) {
    return { intent: 'general_inquiry', confidence: 0, reason: 'empty message' }
  }

  // Score each intent
  const scores = new Map<Intent, { hits: number; matched: string[] }>()
  for (const rule of RULES) {
    let hits = 0
    const matched: string[] = []
    for (const pat of rule.patterns) {
      const m = text.match(pat)
      if (m) {
        hits += rule.weight
        matched.push(m[0].slice(0, 40))
      }
    }
    if (hits > 0) {
      scores.set(rule.intent, { hits, matched })
    }
  }

  if (scores.size === 0) {
    // Nothing matched, treat as general inquiry with low confidence
    return {
      intent: 'general_inquiry',
      confidence: 0.3,
      reason: 'no intent patterns matched, default general_inquiry',
    }
  }

  // Pick highest-scoring intent
  const ranked = Array.from(scores.entries()).sort((a, b) => b[1].hits - a[1].hits)
  const [topIntent, topData] = ranked[0]
  const secondHits = ranked[1]?.[1].hits ?? 0

  // Confidence:
  //   1 hit on a rule => 0.55
  //   2+ hits        => 0.75
  //   clear winner (>=2x next) => boost to 0.85
  let confidence = topData.hits >= 2 ? 0.75 : 0.55
  if (topData.hits >= secondHits * 2 && topData.hits >= 1.5) {
    confidence = Math.min(0.95, confidence + 0.15)
  }
  // human_request is a hard signal
  if (topIntent === 'human_request') confidence = Math.max(confidence, 0.9)
  // spam: be careful, require >=2 hits to escalate confidence
  if (topIntent === 'spam' && topData.hits < 2) confidence = Math.min(confidence, 0.5)

  return {
    intent: topIntent,
    confidence,
    reason: `matched ${topData.matched.length} pattern(s): ${topData.matched.join(', ')}`,
  }
}

/**
 * Map an intent to one or more FAQ keys for grounding context.
 */
export function intentFaqKeys(intent: Intent): import('./faq').FaqKey[] {
  switch (intent) {
    case 'ticket_buyer':
      return [
        'ticket_price', 'ticket_types', 'buy_tickets', 'payment_methods',
        'gate_tickets', 'gift_tickets', 'refund_policy', 'ticket_exchange',
        'ticket_transfer', 'ticket_delivery', 'entry_requirements',
        'accessibility', 'ticket_collection', 'ticket_scan_issue',
        'kids_free_age', 'dates', 'venue',
      ]
    case 'vendor_application':
      return ['vendor_apply', 'stall_sizes', 'halaal_cert', 'electricity']
    case 'vendor_status':
      return ['vendor_apply', 'contact']
    case 'vendor_docs':
      return ['halaal_cert', 'contact']
    case 'vendor_payment':
      return ['vendor_payment_method', 'stall_sizes', 'contact']
    case 'sponsorship':
      return ['contact', 'dates', 'venue']
    case 'general_inquiry':
      return ['dates', 'venue', 'contact', 'website']
    case 'human_request':
    case 'spam':
      return []
  }
}
