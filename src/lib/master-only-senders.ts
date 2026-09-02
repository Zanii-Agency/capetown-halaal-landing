/**
 * Senders whose mail belongs to the master lane, whoever they wrote to.
 *
 * THE GAP THIS CLOSES. The lane seal is built on VENDOR identity: it asks "does
 * this thread resolve to a vendor the festival owner may see?" A bank has no
 * vendor row, so ownerMaySee() returned true by default and every EFT payment
 * notification landed in her inbox. On 2026-07-28 she could read "Notice of
 * payment: Halaal Hub" from ibreply@absa.co.za, "Payment confirmation 1041" from
 * noreply@standardbank.co.za, and an internal dev@cthalaal.co.za alert whose
 * preview read "Le Sucre Artisanal Treats uploaded their E[FT proof]".
 *
 * A wall around vendors does nothing about the bank telling you the vendor paid.
 *
 * DELIBERATELY NARROW, BY SENDER, NOT BY DOMAIN. Blocking every bank domain
 * would have hidden a Capitec partnership pitch and an FNB card-terminal invoice
 * that are genuinely her business. These are the AUTOMATED payment-notification
 * addresses and the operator's own addresses, nothing else. Enumerated rather
 * than pattern-matched so the list is greppable and auditable: someone adding a
 * bank must add it here, which is a decision, not an accident.
 *
 * Extend this when a new bank or notification address appears. The read-side
 * check runs on every mail load, so an addition takes effect everywhere at once.
 */

import { EFT_ADMIN_EMAIL, isOperatorPreviewAddress } from './eft'

/**
 * Automated payment-notification addresses at the banks the festival uses.
 * Every one of these exists to say "money moved", which on this project means
 * an EFT arrived, which is the single fact the master lane exists to hold.
 */
const BANK_NOTIFICATION_SENDERS = new Set([
  'ibreply@absa.co.za',
  'noreply@standardbank.co.za',
  'no-reply@investec.co.za',
  'noreply@nedbank.co.za',
  'noreply@capitecbank.co.za',
  'noreply@fnb.co.za',
  'noreply@fnbstatements.co.za',
])

/**
 * Whole domains that only ever send payment notifications, so a new sender at
 * one of them is still a payment notification. Kept tiny and specific: these
 * are statement/notification subdomains, NOT the banks' main domains, precisely
 * so ordinary correspondence from a bank still reaches her.
 */
const NOTIFICATION_DOMAINS = ['fnbstatements.co.za', 'nedbankmail.co.za']

export function isMasterOnlySender(email?: string | null): boolean {
  const e = (email || '').toLowerCase().trim()
  if (!e) return false

  // The EFT admin's own address. Its alerts are the master's working notes:
  // "<vendor> uploaded their EFT proof" and similar, written for the person
  // running the lane and nobody else.
  if (e === EFT_ADMIN_EMAIL) return true

  // Operator preview addresses already have a rule for exactly this reason.
  if (isOperatorPreviewAddress(e)) return true

  if (BANK_NOTIFICATION_SENDERS.has(e)) return true

  const domain = e.split('@')[1] || ''
  return NOTIFICATION_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
}
