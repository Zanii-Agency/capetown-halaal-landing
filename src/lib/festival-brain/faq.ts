/**
 * Canonical FAQ source of truth for Young at Heart Festival 2026.
 * Pattern-matched BEFORE any LLM call. If a question matches, return canonical text.
 * NEVER let the LLM invent dates, prices, venue, URLs.
 */

export type FaqKey =
  | 'dates'
  | 'venue'
  | 'ticket_price'
  | 'parking'
  | 'kids_play_area'
  | 'kids_free_age'
  | 'vendor_apply'
  | 'halaal_cert'
  | 'refund_policy'
  | 'stall_sizes'
  | 'contact'
  | 'website'
  | 'instagram'
  | 'opening_hours'
  | 'electricity'
  | 'buy_tickets'
  | 'payment_methods'
  | 'gate_tickets'
  | 'gift_tickets'
  | 'ticket_types'
  | 'ticket_exchange'
  | 'ticket_transfer'
  | 'ticket_delivery'
  | 'entry_requirements'
  | 'accessibility'
  | 'ticket_collection'
  | 'ticket_scan_issue'
  | 'vendor_payment_method'
  | 'stall_allocation'
  | 'vendor_approval_time'
  | 'vendor_after_payment'
  | 'vendor_gate_passes'
  | 'vendor_part_payment'

export interface FaqEntry {
  key: FaqKey
  patterns: RegExp[]
  answer: string
  // Short factual snippet used for LLM grounding (no greeting, no sign-off)
  fact: string
  /**
   * Tie-break weight, default 0. matchFaq scores by raw pattern-hit count, so a
   * narrow entry matching one exact phrase loses to a broad entry that happens to
   * match one generic word, and on a tie the earlier-declared key wins. Raise this
   * on entries whose patterns are specific enough that a hit is decisive.
   */
  priority?: number
}

export const FAQ: Record<FaqKey, FaqEntry> = {
  dates: {
    key: 'dates',
    patterns: [
      /\b(when|date[s]?|day[s]?|month|festival on|happening|schedule)\b/i,
      /\b(11|12|13)\s*dec/i,
      /december\s+(11|12|13|2026)/i,
    ],
    fact: 'The festival runs 11, 12 and 13 December 2026 (Friday to Sunday).',
    answer:
      'The festival runs 11, 12 and 13 December 2026, Friday to Sunday. Doors open 10:00 each day. Gates close 22:00 Friday and Saturday, 20:00 Sunday.',
  },
  venue: {
    key: 'venue',
    patterns: [
      /\b(where|venue|location|address|directions|map|how do i get)\b/i,
      /\byoungsfield|wetton|claremont\b/i,
    ],
    fact: 'Venue is Youngsfield Military Base, Wetton Road, Claremont, Cape Town.',
    answer:
      'The festival is at Youngsfield Military Base, Wetton Road, Claremont, Cape Town. Easiest by car or Uber. Claremont train station is a short ride away.',
  },
  ticket_price: {
    key: 'ticket_price',
    patterns: [
      // Price-specific only. Generic "ticket"/"fee"/"entry" and pass NAMES are
      // owned by ticket_types / payment_methods so those route correctly.
      /\b(price|cost|how much|how expensive|pricing)\b/i,
      /\b(r\s?30|r\s?60)\b/i,
      /\bticket.{0,15}\b(price|cost|how much)\b/i,
    ],
    fact: 'Tickets are R30 per day, R60 for the full weekend (all three days). Children under 3 enter free when accompanied by a ticketed adult.',
    answer:
      'Tickets are R30 per day, R60 for the full weekend pass (all three days, saves R30). Children under 3 enter free when accompanied by a ticketed adult. Buy at cthalaal.co.za.',
  },
  parking: {
    key: 'parking',
    patterns: [/\bpark(ing)?\b/i, /\bcar park\b/i],
    fact: 'Free parking is available at the venue. Arrive early on Saturday for best spots.',
    answer:
      'Free parking is available on-site at Youngsfield Military Base. Saturday is the busiest day, so arrive before 12:00 for the best spots.',
  },
  kids_play_area: {
    key: 'kids_play_area',
    patterns: [/\bkids?\s*(zone|area|activit|play|entertainment)\b/i, /\bchild(ren)?\b/i, /\bfamily\b/i],
    fact: 'There is a dedicated kids play area with activities and entertainment all three days.',
    answer:
      'Yes, there is a dedicated kids zone with activities, entertainment and a play area all three days. Children under 3 enter free when accompanied by a ticketed adult.',
  },
  kids_free_age: {
    key: 'kids_free_age',
    patterns: [/\b(kids?|child(ren)?)\s+(under|free|age)\b/i, /\bage limit\b/i, /\bunder 3\b/i, /\b(kids?|child(ren)?)\b.{0,20}\b(need|require).{0,15}\bticket/i, /\bdo (kids?|child(ren)?) (need|pay)\b/i],
    fact: 'Children under 3 enter free when accompanied by a ticketed adult. Ages 3 and up pay the standard ticket price.',
    answer: 'Children under 3 enter free when accompanied by a ticketed adult. From age 3 the standard ticket price applies (R30 day, R60 weekend).',
  },
  vendor_apply: {
    key: 'vendor_apply',
    patterns: [
      /\b(vendor|stall|booth|exhibit|trade|sell|stand)\b/i,
      /\b(apply|application|sign up|register)\b.*\b(vendor|stall|booth|exhibit)\b/i,
      /\bhow do i (apply|become a vendor|get a stall)\b/i,
    ],
    fact:
      'Vendor and stall applications happen at cthalaal.co.za/apply. The form asks for business details, products, and category preference.',
    answer:
      'Vendor and stall applications are at cthalaal.co.za/apply. The form takes a few minutes. After you submit, the team reviews and replies within a few working days.',
  },
  halaal_cert: {
    key: 'halaal_cert',
    patterns: [
      /\bhalaal?\b/i,
      /\b(mjc|sanha|nihit)\b/i,
      /\bcert(ificat(e|ion))?\b/i,
      /\bfood (cert|certified|approved)\b/i,
    ],
    fact:
      'All food vendors must be halaal certified (MJC, SANHA or equivalent recognised body) or carry a valid letter of compliance. Certificates are checked on submission and on-site.',
    answer:
      'All food vendors must be halaal certified by MJC, SANHA or an equivalent recognised body. Upload your certificate with your application. The team checks it on submission and again on-site.',
  },
  refund_policy: {
    key: 'refund_policy',
    patterns: [/\brefund\b/i, /\bmoney back\b/i, /\b(event|festival)\b.{0,25}\bcancel/i, /\bcancel(led|lation)?\b.{0,25}\b(event|festival)\b/i],
    fact:
      'Refunds are available up to 14 days before the event. Tickets bought within 14 days of the event are non-refundable unless the event is cancelled or significantly changed. A full cancellation means a full refund including any booking fees, with buyers contacted via their purchase email. Refunds are processed within 5 to 10 business days to the original payment method.',
    answer:
      'Refunds are available up to 14 days before the event. Tickets bought within 14 days are non-refundable unless the event is cancelled or significantly changed. If the event is fully cancelled you get a full refund including any booking fees, and we contact you on your purchase email. Refunds take 5 to 10 business days back to your original payment method. For help email support@youngatheart.co.za.',
  },
  stall_sizes: {
    key: 'stall_sizes',
    patterns: [
      /\bstall (size|dimension|price|cost|fee)\b/i,
      /\bbooth (size|dimension|price|cost|fee)\b/i,
      /\b3\s?[xX]\s?3|6\s?[xX]\s?3\b/,
      /\bhow much.*(stall|booth)\b/i,
    ],
    fact:
      'Stall sizes range from 2x2m tables up to 6x3m full double layouts. Marquee stall fees run R3,700 to R12,000 depending on size and category. Food and drink trucks are an outside zone with their own fee. Electricity is an optional add-on (R400 to R750). Full pricing is on the application form.',
    answer:
      'Stall sizes start at a 2x2m table and go up to 6x3m. Marquee stall fees run R3,700 to R12,000 depending on size and category. Food and drink trucks are an outside zone with their own fee. Electricity is optional, R400 to R750. Full options and exact prices are on cthalaal.co.za/apply.',
  },
  contact: {
    key: 'contact',
    patterns: [
      /\b(contact|email|phone|number|reach|get hold of|speak to (someone|a human|the team))\b/i,
      /\bsupport@\b/i,
    ],
    fact: 'Contact the festival team at support@youngatheart.co.za.',
    answer:
      'Email the festival team at support@youngatheart.co.za. Someone replies within a few working hours.',
  },
  website: {
    key: 'website',
    patterns: [/\b(website|site|web|url|link)\b/i, /\bcthalaal\b/i, /\byoungatheart\b/i],
    fact: 'Website: cthalaal.co.za. Tickets: cthalaal.co.za. Vendor apply: cthalaal.co.za/apply.',
    answer:
      'Website is cthalaal.co.za. Tickets and vendor applications are both on the same site.',
  },
  instagram: {
    key: 'instagram',
    patterns: [/\binstagram\b/i, /\big handle\b/i, /\bsocial\b/i, /@youngatheart/i],
    fact: 'Instagram: @youngatheart_capetown.',
    answer: 'Follow @youngatheart_capetown on Instagram for daily updates.',
  },
  opening_hours: {
    key: 'opening_hours',
    patterns: [
      /\b(open(ing)?\s*hours?|what time|hours|close[s]?|gates|doors)\b/i,
      /\bstart time\b/i,
    ],
    fact:
      'Gates open 10:00 each day. Friday and Saturday close 22:00. Sunday closes 20:00.',
    answer:
      'Gates open 10:00 every day. Friday and Saturday run to 22:00, Sunday to 20:00.',
  },
  electricity: {
    key: 'electricity',
    patterns: [/\belectric(ity|al)?\b/i, /\bpower (point|outlet|supply)\b/i, /\bplug\b/i],
    fact: 'Electricity is an optional add-on for stalls: R400 to R750 depending on load.',
    answer:
      'Electricity is an optional add-on for stalls, R400 to R750 depending on the load. Tick the box on the application form.',
  },
  buy_tickets: {
    key: 'buy_tickets',
    patterns: [
      /\b(where|how)\b.*\b(buy|purchase|get|book)\b.*\bticket/i,
      /\b(buy|purchase|book)\b.*\bticket/i,
      /\bticket.*\b(buy|purchase|book|online)\b/i,
    ],
    fact:
      'Tickets are sold online at cthalaal.co.za and in person at Youngsfield Military Base. Buying online lets you skip the queues.',
    answer:
      'You can buy tickets online at cthalaal.co.za or in person at Youngsfield Military Base. Buy online to skip the queues at the gate.',
  },
  payment_methods: {
    key: 'payment_methods',
    patterns: [
      /\b(payment|pay)\s*(method|option|type)?s?\b/i,
      /\b(credit|debit)\s*card\b/i,
      /\b(visa|mastercard)\b/i,
      /\bcash\b/i,
      /\bhow (can|do) i pay\b/i,
      /\b(booking|extra|hidden|service|additional)\s*fees?\b/i,
      /\bany\s*(extra\s*)?fees?\b/i,
      /\bis there\b.{0,15}\bfee/i,
    ],
    fact:
      'Payment is by major credit and debit cards (Visa, Mastercard), and cash at the event. There is no booking fee for online or in-person purchases.',
    answer:
      'We accept major credit and debit cards (Visa, Mastercard) and cash at the event. There is no booking fee for either online or in-person purchases.',
  },
  // Vendor-side payment (stall fee), NOT the ticket_buyer payment_methods entry
  // above. CTH does not accept EFT/bank transfer, ever (hard rule 2026-07-11:
  // a production bot invented "the team will send EFT details" and left a
  // vendor stuck waiting for a payment method that doesn't exist). Card only,
  // via the Yoco link in the exhibitor portal.
  vendor_payment_method: {
    key: 'vendor_payment_method',
    // A vendor noun ("stall in cash", "the invoice") is decisive: no ticket
    // buyer phrases a question that way. Without this, payment_methods wins on
    // the bare word "pay" plus declaration order and answers a stall-fee ask
    // with "we accept cash at the event", which is false for stall fees. The
    // intent gate in festival-brain.ts catches most of those, but not when the
    // classifier reads the message as ticket_buyer ("can I pay my stall in
    // cash"), where payment_methods is an allowed key and serves canned.
    priority: 1,
    patterns: [
      // Any EFT/banking ask is decisive on its own: CTH has never had a
      // bank-transfer option, so the question can only be about a stall fee.
      // "banking" needs the optional -ing, without it "banking details" matched
      // nothing at all and fell through to the LLM unguarded, which is the exact
      // shape of the 2026-07-11 invented-EFT incident.
      /\b(eft|bank(ing)?\s*(details|account|transfer)|swift|account\s*number)\b/i,
      // Bare "fee" is a ticket-buyer word (booking fee, service fee), so it only
      // counts here when a vendor noun scopes it. Plural both sides: a vendor
      // holding two stalls asks about "my stall fees" (multi-stall, c96fb91).
      /\b(stall|stand|booth|exhibitor|vendor)s?\s*(fee|payment|invoice)s?\b/i,
      // "invoice" and "exhibitor" are unambiguous, no determiner needed.
      /\bpay\b.{0,20}\b(invoice|exhibitor)\b/i,
      // stall/stand/booth need a possessive here. Bare nouns would hijack ticket
      // buyers two ways: "stand" is also a verb ("pay to stand at the front"),
      // and "stalls" is what a ticket buyer calls the food traders ("pay the
      // food stalls in cash"). Both are this entry's own misroute, reversed.
      /\bpay\b.{0,15}\b(my|our|both)\b.{0,10}\b(stall|stand|booth)s?\b/i,
    ],
    fact:
      'Vendor stall fees are paid by card only (Yoco), through the exhibitor portal at cthalaal.co.za/exhibitor/login. There is no EFT or bank transfer option.',
    answer:
      'There is no EFT or bank transfer option for stall fees, sorry for any confusion. Payment is by card only (Yoco), through your exhibitor portal at cthalaal.co.za/exhibitor/login. Log in, open your invoice, and pay there. If you cannot access the portal, reply here and the team will send you the Yoco payment link directly.',
  },
  gate_tickets: {
    key: 'gate_tickets',
    patterns: [
      /\b(gate|door|on the day|day of|same day|walk[\s-]?in)\b.*\bticket/i,
      /\bticket.*\b(at the (gate|door)|on the day)\b/i,
      /\bcan i (just )?(buy|get|pay).*\b(gate|door|on the day)\b/i,
    ],
    fact:
      'Tickets may be available at the gate subject to availability. Advance purchase is recommended because capacity is limited and there may be queues.',
    answer:
      'Tickets may be available at the gate on the day, subject to availability. We recommend buying in advance, since capacity is limited and there can be queues.',
  },
  gift_tickets: {
    key: 'gift_tickets',
    patterns: [
      /\bgift\b/i,
      /\bticket.{0,20}\bgift\b/i,
      /\bgift\b.{0,20}\bticket/i,
      /\bticket.*\b(for|in)\b.*\b(someone else|another person|a friend)\b.*\bname\b/i,
      /\bbuy.*\bfor (someone|a friend|my)\b/i,
    ],
    fact:
      'Tickets can be bought as a gift in someone else\'s name. Enter the recipient\'s details at checkout, or contact the team to arrange it.',
    answer:
      'Yes, you can buy a ticket as a gift. Just enter the recipient\'s details at checkout, or contact us at support@youngatheart.co.za and we will arrange it.',
  },
  ticket_types: {
    key: 'ticket_types',
    patterns: [
      /\b(ticket|pass)\s*(type|option|kind|category)s?\b/i,
      /\b(day|weekend)\s*pass\b/i,
      /\brider\b/i,
      /\bwhat tickets? (are|do you)\b/i,
    ],
    fact:
      'Ticket types are: Day Pass (single-day access), Weekend Pass (all days at a reduced combined price), and Rider Tickets (carnival access). Full pricing is on cthalaal.co.za.',
    answer:
      'There are three ticket types: a Day Pass for single-day access, a Weekend Pass for all days at a reduced combined price, and Rider Tickets for carnival access. See cthalaal.co.za for full pricing.',
  },
  ticket_exchange: {
    key: 'ticket_exchange',
    patterns: [
      /\bexchange\b/i,
      /\bswap\b.*\b(date|day|ticket)\b/i,
      /\bchange\b.*\b(my )?(date|day)\b/i,
      /\bdifferent (day|date)\b/i,
    ],
    fact:
      'Exchanges are permitted up to the day before the ticketed session, subject to availability. Contact the team to arrange an exchange.',
    answer:
      'You can exchange a ticket up to the day before your ticketed session, subject to availability. Email support@youngatheart.co.za to arrange it.',
  },
  ticket_transfer: {
    key: 'ticket_transfer',
    patterns: [
      /\btransfer\b/i,
      /\bgive\b.*\bticket.*\b(to )?(someone|another person|a friend)\b/i,
      /\bsomeone else\b.*\bgo\b/i,
      /\bchange\b.*\b(the )?name\b/i,
    ],
    fact:
      'Tickets can be transferred to someone else free of charge. Contact the team with the new attendee\'s details before the event.',
    answer:
      'Yes, you can transfer your ticket to someone else free of charge. Contact us at support@youngatheart.co.za with the new attendee\'s details before the event.',
  },
  ticket_delivery: {
    key: 'ticket_delivery',
    patterns: [
      /\b(receive|get|sent|delivered|arrive)\b.*\bticket/i,
      /\bticket.*\b(email|e[\s-]?ticket|pdf|sent|delivered)\b/i,
      /\bwhere('| i)s my ticket\b/i,
    ],
    fact:
      'Online purchases are sent to the buyer\'s email as a PDF or e-ticket. You can show it on your phone or print it. Both are accepted at the gate.',
    answer:
      'Online tickets are emailed to you as a PDF, or e-ticket. You can show it on your phone or print it out, and both are accepted at the gate.',
  },
  entry_requirements: {
    key: 'entry_requirements',
    patterns: [
      /\bwhat\b.*\b(bring|need)\b.*\b(entry|enter|get in|gate)\b/i,
      /\bneed\b.*\bto (get|bring)\b.*\bin\b/i,
      /\bdo i need\b.*\b(ticket|anything)\b.*\b(enter|entry|gate|get in)\b/i,
    ],
    fact:
      'To enter you need your ticket, either digital or printed.',
    answer:
      'All you need to get in is your ticket, either digital on your phone or printed.',
  },
  accessibility: {
    key: 'accessibility',
    patterns: [
      /\b(wheelchair|accessible|accessibility|mobility|disabled|disability)\b/i,
      /\bpriority viewing\b/i,
    ],
    fact:
      'The site is wheelchair accessible with dedicated pathways, accessible toilets, and priority viewing areas. Contact the team in advance for specific assistance.',
    answer:
      'Yes, the site is wheelchair accessible with dedicated pathways, accessible toilets, and priority viewing areas. For specific assistance, contact us in advance at support@youngatheart.co.za.',
  },
  ticket_collection: {
    key: 'ticket_collection',
    patterns: [
      /\b(collect|collection|pick up|pickup)\b.*\bticket/i,
      /\bticket.*\b(collect|collection|pick up|pickup)\b/i,
      /\bwhere\b.*\bcollect\b/i,
    ],
    fact:
      'In-person tickets are collected at the main entrance on event days.',
    answer:
      'You can collect in-person tickets at the main entrance on event days.',
  },
  ticket_scan_issue: {
    key: 'ticket_scan_issue',
    patterns: [
      /\bscan\b/i,
      /\bticket.*\b(won'?t|wont|not|doesn'?t|does not|can'?t)\b.*\b(work|scan|open)\b/i,
      /\b(qr|barcode)\b.*\b(work|scan|invalid)\b/i,
    ],
    fact:
      'If an e-ticket will not scan, go to the customer service desk at the entrance with the booking confirmation email ready. Staff will assist.',
    answer:
      'If your e-ticket will not scan, head to the customer service desk at the entrance with your booking confirmation email ready, and staff will sort it out.',
  },
  // Vendor-lifecycle facts — public-safe (no prices, no floor-plan detail), so
  // the WhatsApp bot can answer "when do I get my stall / has allocation started"
  // without deferring. Operational pricing stays in VENDOR_ONLY_FAQ.
  stall_allocation: {
    key: 'stall_allocation',
    patterns: [
      /\b(stall|spot|space|pitch|table).{0,20}\b(alloc|assign|number|placement|where|which|get|receive|confirm)\b/i,
      /\b(alloc|placement)\b/i,
      /\bwhere.{0,10}(is|will).{0,10}(my|the).{0,10}(stall|spot|space)\b/i,
      /\bhas.{0,15}(allocation|stall).{0,15}(start|begun|happen)\b/i,
      /\bwhen.{0,20}(get|know|receive).{0,15}(my )?(stall|spot|space|placement)\b/i,
    ],
    fact:
      'Stall allocation happens closer to the festival, not yet. After a vendor is approved and has paid, they wait for their stall to be allocated and emailed to them. Outdoor spots (trucks, bedouin) are allocated on setup day, not in advance.',
    answer:
      'Stall allocation happens closer to the festival, so it has not started yet. Once you are approved and have paid, you wait for your stall to be allocated and emailed to you. Outdoor spots are allocated on setup day.',
  },
  vendor_approval_time: {
    key: 'vendor_approval_time',
    patterns: [
      /\b(how long|when).{0,25}(approv|accept|hear back|response|review)\b/i,
      /\bapprov.{0,15}(take|long|time|wait)\b/i,
      /\bstill.{0,10}waiting.{0,15}(approv|review|response)\b/i,
    ],
    fact:
      'Vendor applications are reviewed and approval takes a few working days.',
    answer:
      'Applications are reviewed and approval usually takes a few working days. Once you are approved you will be able to pay and manage everything in your exhibitor portal.',
  },
  vendor_after_payment: {
    key: 'vendor_after_payment',
    patterns: [
      /\b(paid|payment done|after.{0,10}pay|next step|what.{0,10}now).{0,20}(stall|next|happen|then)?\b/i,
      /\bi.{0,5}(have )?paid\b/i,
      /\bwhat.{0,15}(happens|next).{0,15}(after|once).{0,10}(i )?pay\b/i,
    ],
    fact:
      'After paying, the vendor gets a confirmation and tax invoice by email, then waits for their stall to be allocated closer to the festival. Everything (invoice, documents, staff passes, stall) is managed in the exhibitor portal.',
    answer:
      'After you pay, you get a confirmation and tax invoice by email. Your stall is then allocated closer to the festival and emailed to you. You can view your invoice, upload documents, and add staff in your exhibitor portal.',
  },
  vendor_gate_passes: {
    key: 'vendor_gate_passes',
    patterns: [
      /\b(staff|team|helper|worker).{0,15}(pass|gate|entry|access|badge|ticket)\b/i,
      /\bgate pass|access pass|staff badge\b/i,
      /\bhow many.{0,10}(staff|people|team).{0,15}(bring|allow|pass)\b/i,
    ],
    fact:
      'Approved vendors add their staff for gate passes in the exhibitor portal, so their team can get through the gate on event days.',
    answer:
      'You add your staff for gate passes in your exhibitor portal at cthalaal.co.za/exhibitor/login, so your team can get through the gate on event days.',
  },
  // Part-payment asks on the STALL FEE. Deliberately absent from intentFaqKeys(),
  // so the Step-1 intent gate in festival-brain.ts always drops it as a canned
  // short-circuit and it reaches the model as grounding instead. That is load
  // bearing twice over: the reply comes out personal (first name + mirrored ask
  // from the ABOUT THE SENDER block) rather than a canned notice, and grounding
  // only ever speaks when asked, so the bot cannot volunteer or broadcast it.
  // Public-safe: states terms, never prices. Directly addresses the misroute
  // logged at festival-brain.ts:272 (an instalment question answered with
  // payment methods).
  vendor_part_payment: {
    key: 'vendor_part_payment',
    // These patterns only fire on explicit part-payment language, so one hit is
    // decisive. Without this, "can I do a part payment" ties payment_methods on
    // the bare word "payment" and loses on declaration order, which is the
    // instalment-answered-with-payment-methods misroute all over again.
    // Band 2, above vendor_payment_method's 1: "pay my stall fee in instalments"
    // hits both, and HOW to pay is the wrong answer to WHETHER it can be split.
    // Same band would hand it to vendor_payment_method on declaration order.
    priority: 2,
    patterns: [
      /\bpart[\s-]?payments?\b/i,
      /\binstall?ments?\b/i,
      /\blay[\s-]?(by|bye|away)\b/i,
      /\bdeposit\b/i,
      /\bpay\b.{0,20}\bin\s+(parts|bits|stages|chunks|install?ments?)\b/i,
      /\bpay\b.{0,15}\b(half|some|a portion|a part|a percentage)\b/i,
      /\b(half|50\s?%)\b.{0,10}\bnow\b/i,
      /\bsplit\b.{0,15}\b(the\s+)?(payment|fee|cost|amount|bill)\b/i,
      /\bpay\b.{0,10}\b(it\s+)?off\b/i,
      /\bnow\b.{0,20}\brest\b.{0,20}\blater\b/i,
      /\bpay\b.{0,15}\bmonthly\b/i,
    ],
    fact:
      'Stall fees are not split into part payments, instalments or deposits. The full amount is what settles the stall. A vendor who cannot meet their own payment due date can take until 31 August 2026 to settle in full and keeps their reserved space until then, but this is only offered when they ask for it. Their original due date still stands, so they keep seeing the payment as due and may still receive reminders in the meantime.',
    // zanii-codef: unreachable while this key stays out of intentFaqKeys(); kept
    // truthful so it degrades correctly if anyone ever wires it as a canned answer.
    answer:
      'We are not able to take the stall fee in parts. The full amount is what settles the stall, and your space stays reserved for you. If the due date on your account is tight, you can take until 31 August 2026 to settle in full. Your account will still show the payment as due and you may still get reminders in the meantime, that is expected as long as you settle by then.',
  },
}

/**
 * Pattern-match an inbound message against the FAQ.
 * Returns the highest-confidence match by pattern count.
 */
export function matchFaq(message: string): FaqEntry | null {
  const text = message.toLowerCase()
  let best: { entry: FaqEntry; score: number; priority: number } | null = null

  for (const entry of Object.values(FAQ)) {
    let score = 0
    for (const pat of entry.patterns) {
      if (pat.test(text)) score += 1
    }
    if (score === 0) continue
    const priority = entry.priority ?? 0
    // Priority dominates, hit-count breaks ties within a priority band.
    if (!best || priority > best.priority || (priority === best.priority && score > best.score)) {
      best = { entry, score, priority }
    }
  }

  return best?.entry ?? null
}

/**
 * Build a compact grounding context for the LLM from one or more FAQ entries.
 * Used in step 3 when we fall through to the LLM.
 */
export function buildGroundingContext(keys: FaqKey[]): string {
  if (keys.length === 0) return ''
  const lines = keys.map((k) => `- ${FAQ[k].fact}`)
  return ['CANONICAL FACTS (do not contradict, do not invent alternatives):', ...lines].join('\n')
}
