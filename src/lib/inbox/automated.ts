/**
 * "Is this sender a machine?"
 *
 * Lifted verbatim from the unified inbox route, where it was written after the
 * Needs You queue filled up with Smart Points travel deals and Substack
 * newsletters. The per-channel loaders were built without it and immediately
 * reproduced the bug: 37 of 45 Gmail threads pinned as "waiting on a person".
 * A pin that fires on 82% of a list is not a queue, it is wallpaper.
 *
 * Two axes, deliberately conservative so a real cold enquiry from a person
 * (admin@somecompany.co.za) is never matched:
 *   - an automated LOCAL part (noreply, newsletter, billing alerts…)
 *   - a known bulk/ESP DOMAIN (Mailchimp, Substack, SendGrid…)
 * Plus our OWN domains, because a system self-notification landing as a "peer"
 * (the notifyOwners email backstop) is never a customer.
 *
 * This only suppresses the PIN. The thread stays fully visible in its channel
 * list, exactly as before: the claim is "no human is waiting on you", not "this
 * does not exist".
 */

const AUTOMATED_LOCAL = /(^|[._-])(no?[._-]?reply|do[._-]?not[._-]?reply|donotreply|mailer[._-]?daemon|mailer|bounce|postmaster|newsletter|marketing|promo|promotions?|notifications?|notify|alerts?|updates?|deals?|offers?|campaigns?|automated)([._-]|$)/
const BULK_DOMAIN = /(substack\.com|mailchimp|mcsv\.net|mcdlv\.net|sendgrid|sparkpostmail|mailgun|amazonses|sendinblue|brevo|brevosend|metamail\.com|hubspot|marketo|klaviyomail|list-manage|constantcontact|dollarflightclub\.com|thedailynavigator|sage\.com|smartcall\.co\.za|beehiiv|convertkit|drip\.com|activehosted|customer\.io|intercom-mail|mailerlite|getresponse|aweber)/
const INTERNAL_DOMAIN = /(^|\.)(youngatheart\.co\.za|cthalaal\.co\.za)$/

export function isAutomatedEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const at = email.toLowerCase().indexOf('@')
  if (at < 0) return false
  const local = email.slice(0, at).toLowerCase()
  const domain = email.slice(at + 1).toLowerCase()
  return AUTOMATED_LOCAL.test(local) || BULK_DOMAIN.test(domain) || INTERNAL_DOMAIN.test(domain)
}

/**
 * Should this thread be allowed to pin?
 *
 * A thread that resolves to a VENDOR always can, whatever their address looks
 * like. Someone who applied for a stall is a real person we owe a reply, and a
 * vendor whose business address happens to be info@ or updates@ must never be
 * silently demoted out of the queue. Only unresolved senders are judged by the
 * address alone.
 */
export function canPin(thread: { email?: string | null; application_id?: string | null; phone?: string | null }): boolean {
  if (thread.application_id || thread.phone) return true
  return !isAutomatedEmail(thread.email)
}
