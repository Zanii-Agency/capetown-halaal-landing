// The acknowledgement a vendor gets when they upload a proof of payment.
//
// Taona 2026-07-29, approved verbatim: confirm we have their proof, say we will
// confirm once the funds reflect, and point them at the official channels.
//
// BEFORE THIS, A VENDOR WHO UPLOADED A PROOF RECEIVED NOTHING. The upload route
// fired notifyOwners and stopped, so Aurelia sat from 29 July with no reply
// while the operator alert went out fine. Silence after handing over money is
// the worst moment in the whole flow to be silent.
//
// One module because the same words go out two ways: a manual catch-up send for
// vendors who already uploaded, and automatically on every future upload. Two
// copies of this text would drift on the first edit.
//
// TONE. "To help us serve you faster", never "please avoid messaging team
// members personally". Taona cut exactly that line from the Le Sucre email on
// 2026-07-28, so official channels are framed as a benefit to the vendor rather
// than a rule aimed at them.
//
// NO DATE IS PROMISED. Reconciliation depends on the bank, so the copy says
// "as soon as the funds reflect" and never puts a number on it.
//
// The phrase "proof of payment" is deliberate and safe: the vendor uploaded it,
// so they already know. It also trips revealsPaymentArrangement, which means
// these acknowledgements are automatically withheld from the festival owner's
// inbox without anyone having to remember to hide them.

export const PROOF_ACK_PORTAL = 'cthalaal.co.za/exhibitor/portal'
export const PROOF_ACK_EMAIL = 'support@youngatheart.co.za'
export const PROOF_ACK_PHONE = '+27 65 943 5012'

export function proofAckSubject(businessName: string): string {
  return `We have your proof of payment, ${businessName}`
}

/** WhatsApp body. Goes into festival_announcement as {{2}}, which renders after
 *  "Hi {{1}}!", so it must NOT open with its own greeting. */
export function proofAckWhatsApp(businessName: string): string {
  return (
    `Jazakallah, we have received your proof of payment for ${businessName}. ` +
    `It is with our finance team now, and we will confirm as soon as the funds reflect. ` +
    `Your portal updates automatically, so there is nothing further you need to do.\n\n` +
    `For anything else, please use your vendor portal (${PROOF_ACK_PORTAL}), this WhatsApp number, ` +
    `or ${PROOF_ACK_EMAIL}. Those reach the whole team and are tracked against your application, ` +
    `so we can help you faster.`
  )
}

/** Plain-text email body, used as the text alternative and by any caller that
 *  cannot render React. */
export function proofAckText(contactFirstName: string, businessName: string): string {
  return `Assalamu alaikum ${contactFirstName},

Jazakallah, we have received your proof of payment for ${businessName}. It is with our finance team now.

We will confirm as soon as the funds reflect on our side, and your vendor portal updates automatically once that happens. There is nothing further you need to do in the meantime.

To help us serve you faster, please keep festival queries on our official channels:

  Your vendor portal:  ${PROOF_ACK_PORTAL}
  Email:               ${PROOF_ACK_EMAIL}
  WhatsApp and phone:  ${PROOF_ACK_PHONE}

Anything that comes in on these reaches the whole team and is tracked against your application, so nothing gets missed and whoever is available can pick it up for you straight away.

Jazakallah,
The Young at Heart Festival Team`
}

/** Law 7 guard. Exported so both senders assert it rather than trusting that
 *  the constant above never gets edited by someone in a hurry. */
export function hasLongDash(s: string): boolean {
  return /[—–]/.test(s)
}
