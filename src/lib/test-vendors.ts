// Seed / demo / probe rows that live in vendor_applications alongside real
// vendors. They exist so the portal, the invoice renderer and the admin surfaces
// have something to render against, and they must never receive a real vendor
// communication: a reminder to a demo row is a real email leaving the CTH Resend
// account and a real WhatsApp template billed against the Meta number.
//
// scripts/chase-all-unpaid.tsx carried its own private exclusion list while the
// payment cron carried none, so the same demo row was correctly skipped by the
// manual chase and queued for a send by the automated one. One predicate, used
// by every sender, so a new seed row only has to be declared once.

/** Business names that are seed data, lower-cased. */
const TEST_VENDOR_NAMES: ReadonlySet<string> = new Set([
  'demo halal kitchen',
  'sweet treats demo',
  'probe-rate',
])

/** Addresses that can only belong to seed data: our own demo-/test- mailboxes
 *  and the RFC 2606 reserved domains used by probes. */
const TEST_EMAIL_RE = /^(demo|test)[-.]|@example\.(com|org|net)$/i

/**
 * True when this application row is seed data rather than a real vendor.
 * Call before ANY outbound send (email, WhatsApp) or payment chase.
 */
export function isTestVendor(v: {
  business_name?: string | null
  email?: string | null
}): boolean {
  if (TEST_VENDOR_NAMES.has((v.business_name || '').trim().toLowerCase())) return true
  return TEST_EMAIL_RE.test((v.email || '').trim())
}
