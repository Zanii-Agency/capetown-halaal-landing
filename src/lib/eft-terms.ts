// Single source of truth for the EFT payment terms shown to vendors (the portal
// EFT panel) AND used to ground the inbox smart-reply AI, so the rules a vendor
// reads and the rules the team's drafted replies state can never drift apart.
//
// Client-safe: NO server imports, so both a 'use client' component and a server
// route may import it. Plain static copy. No em-dashes (CTH-DOCTRINE law 7).

export const EFT_TERMS_HEADING = 'Important, please read before you pay by EFT'

export const EFT_TERMS: string[] = [
  'Please respect the investment we have made in building this platform. It is here to give you a smoother experience and keep our team efficient, so please use it rather than working around it. Send your proof of payment one way only: upload it on this page, or email support@youngatheart.co.za. Please do not use any other email, or message a team member directly via WhatsApp. Keeping everything here reaches the whole team at once and gets you confirmed the fastest, even while the festival keeps everyone busy.',
  'Use only your own genuine proof of payment. Submitting a fake or altered proof of payment will be reported to the relevant authorities.',
]

// One-line form for prompts / plain-text channels.
export const EFT_TERMS_TEXT = EFT_TERMS.join(' ')
