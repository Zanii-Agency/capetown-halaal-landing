// Single source of truth for the EFT payment terms shown to vendors (the portal
// EFT panel) AND used to ground the inbox smart-reply AI, so the rules a vendor
// reads and the rules the team's drafted replies state can never drift apart.
//
// Client-safe: NO server imports, so both a 'use client' component and a server
// route may import it. Plain static copy. No em-dashes (CTH-DOCTRINE law 7).

export const EFT_TERMS_HEADING = 'Important, please read before you pay by EFT'

export const EFT_TERMS: string[] = [
  'Pay the full stall fee in ONE transaction. We are not accepting part payments or deposits.',
  'A part payment does not secure your stall. Any partial amount will be refunded, and your slot may be released to a vendor on the waiting list.',
  'Use only your own genuine proof of payment. Submitting a fake or altered proof of payment will be reported to the relevant authorities.',
]

// One-line form for prompts / plain-text channels.
export const EFT_TERMS_TEXT = EFT_TERMS.join(' ')
