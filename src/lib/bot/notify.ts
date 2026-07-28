// Push portal events to the admin allowlist on WhatsApp + log to the Bot Inbox.
// Keeps Samreen "in the loop in real time" per ask. Best-effort: a failure here
// never breaks the originating request — the caller catches+continues.
//
// Pattern source: project_nisria_notifications (lib/notify.ts). Same shape,
// reused here with our approved Meta templates.

import { sendTemplate, sendText, toE164 } from '@/lib/whatsapp'
import { BOT_ADMINS, type BotAdmin } from '@/lib/bot/admins'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { getEftMode, EFT_ADMIN_EMAIL, mentionsEft, vendorInOwnerScope } from '@/lib/eft'

// EMAIL BACKSTOP for the silent-drop failure surface. Meta frequency-caps owner
// alerts; production regressed to 86% of owner WhatsApp sends dropped with
// "healthy ecosystem engagement" (KT #206651 diagnosis). The old carve-out
// excluded admin-initiated events (approve/reject/info/document) on the theory
// the admin "already knows" — but the live query proved that false: 7 of 30
// sampled failures were `application_approved` confirmations the team never saw.
// So EVERY event now gets an email backstop. Email has no frequency cap.
const EMAIL_BACKSTOP_EVENTS: ReadonlySet<PortalEvent> = new Set<PortalEvent>([
  'application_received',
  'application_approved',
  'application_rejected',
  'application_info_requested',
  'payment_succeeded',
  'payment_failed',
  'document_uploaded',
  'vendor_support_message',
  'system_alert',
])

export type PortalEvent =
  | 'application_received'
  | 'application_approved'
  | 'application_rejected'
  | 'application_info_requested'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'document_uploaded'
  | 'vendor_support_message'
  | 'system_alert'

interface NotifyArgs {
  event: PortalEvent
  body: string // one-line summary, will be wrapped by the template
  audience?: 'all' | 'master' | 'festival_owner'
  /** E.164 to skip — e.g. the admin who just replied shouldn't be notified of
   *  their own message (used to mirror a reply to the OTHER support agent). */
  exclude?: string
  /** The vendor this alert is ABOUT. Pass it whenever the alert concerns ONE
   *  identifiable vendor and the lane decides who may see it — notifyOwners looks
   *  the row up and applies the single canonical predicate (vendorCommsInEftLane)
   *  itself. Callers pass an id, never hand-copied lane columns: assembling
   *  admin_notes/paid_at/email/phone by hand at each call site is exactly what
   *  produced the two divergent checks this field replaces (registry.ts hardcoded
   *  paidAt:null -> over-muted paid vendors; vendor-brain.ts hand-rolled a
   *  predicate missing five conditions -> under-muted).
   *
   *  OMIT IT when no single vendor applies (batch digests, sponsor enquiries) or
   *  when the alert must always reach the owner (a brand-new application, whose
   *  null admin_notes + null paid_at would otherwise read as in-lane under global
   *  mode). Omitting is FAIL-OPEN: the owner still sees the alert. */
  vendorId?: string
  /** Same purpose as vendorId for callers that only know a phone number (the
   *  WhatsApp webhook). Resolved by last-9 subscriber key, the canonical join
   *  since 09ced95, so +27…/0…/local formats all match. */
  vendorPhone?: string
  /** Legacy escape hatch for callers that can only identify the vendor by PHONE
   *  (the WhatsApp webhook, via eftScopedForPhone). Prefer vendorId: a resolved
   *  vendor row overrides this flag in both directions, so a stale `true` can
   *  never mute an alert about a vendor who has since been reconciled. */
  eftScoped?: boolean
}

/** The four vendor_applications columns that decide the comms lane. */
type VendorLaneRow = { admin_notes: unknown; paid_at: unknown; email: unknown; phone: unknown }

const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Should this alert be withheld from the festival owner (Samreen)? Pure, so the
 *  routing rule is unit-testable without the Supabase/WhatsApp/Resend side effects.
 *
 *  Precedence:
 *    1. vendor row present -> THE ROW IS THE TRUTH. Body text and eftScoped are
 *       both ignored. This is load-bearing: confirmPayment's body reads "marked
 *       paid via eft", and under the old body-text rule that muted the owner from
 *       the very alert telling her a vendor had settled and become hers. It
 *       supersedes the 2026-07-24 blanket "any EFT mention is withheld" rule,
 *       under the 2026-07-25 rule: EFT vendors stay on master through 'collected'
 *       and return to the owner on Yoco reconciliation (paid_at set).
 *    2. no row -> fall back to the heuristics (body text, or an explicit flag).
 *    3. neither -> false. She sees it. FAIL-OPEN, deliberately: an over-share is
 *       visible and recoverable (she asks why she got it), whereas a wrong mute is
 *       SILENT — no error, no log, the alert simply never arrives. Her job is
 *       approving vendors, so a silent blackout is the worse failure. */
export function isEftScopedAlert(
  args: { body: string; eftScoped?: boolean },
  vendor: VendorLaneRow | null,
  _globalOn: boolean,
): boolean {
  if (vendor) {
    // Withhold unless this vendor is in HER world at all. Taona 2026-07-26:
    // "samreen should never have access to unpaid vendors except for when they
    // sign up, sign contract". Those two moments are carve-outs at their call
    // sites (they pass no vendorId), so anything that reaches here and names a
    // vendor is gated on whether that vendor has paid through her channel.
    //
    // Note this is the INVERSE of the old test: we now ask "is this hers?" and
    // withhold otherwise, rather than asking "is this vendor on the EFT lane?".
    // The old shape handed an EFT-SETTLED vendor back to her the moment paid_at
    // was written, which is exactly what she must not get.
    return !vendorInOwnerScope(asStr(vendor.admin_notes), asStr(vendor.paid_at))
  }
  return mentionsEft(args.body) || args.eftScoped === true
}

// Best-effort: a miss or a throw returns null, which degrades to the heuristics
// above rather than guessing a lane from an absent row.
async function lookupVendorLane(id?: string, phone?: string): Promise<VendorLaneRow | null> {
  try {
    const q = createAdminClient().from('vendor_applications').select('admin_notes, paid_at, email, phone')
    if (id) {
      const { data } = await q.eq('id', id).limit(1)
      return (data?.[0] as VendorLaneRow | undefined) ?? null
    }
    const last9 = (phone || '').replace(/\D/g, '').slice(-9)
    if (!last9) return null
    // No .limit(1): on a last-9 collision, take the row that is NOT hers so a
    // master-lane vendor can never hide behind another matching number.
    const { data } = await q.or(`phone.like.*${last9},admin_notes.like.*WAV${last9}*`)
    const rows = (data || []) as VendorLaneRow[]
    return rows.find((r) => !vendorInOwnerScope(asStr(r.admin_notes), asStr(r.paid_at))) ?? rows[0] ?? null
  } catch {
    return null
  }
}

// Logs every send to wa_messages so the Bot Inbox surfaces it next to admin
// replies — one feed for owner attention.
async function deliverOne(admin: BotAdmin, args: NotifyArgs, fallbackEmail?: string) {
  const db = createAdminClient()
  const e164 = toE164(admin.phone)
  const firstName = admin.name.split(/\s+/)[0]

  // Template params reject newlines, so the template path flattens to ' · '.
  const logBody = `${args.event.replace(/_/g, ' ').toUpperCase()} - ${args.body.replace(/\s*\n\s*/g, ' · ')}`

  // Multiplicity guard: the same owner alert often fires several times (the
  // transcript shows identical "Logged for you" / "Got it" pings x4-x7), which
  // both spams the admin AND burns into Meta's frequency cap. Skip an identical
  // alert to the same admin within a 5-minute window (idempotent on body).
  const { data: recentDup } = await db
    .from('wa_messages')
    .select('id, created_at')
    .eq('wa_phone', e164)
    .eq('direction', 'out')
    .eq('body', logBody)
    .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .limit(1)
  if (recentDup && recentDup.length > 0) {
    return // duplicate owner alert within 5 min, already delivered
  }

  // FREE TEXT FIRST, TEMPLATE ONLY AS THE FALLBACK.
  //
  // This reverses "ALWAYS use the approved template" (KT #206651), and the
  // reversal is the point. That note blamed the 86% silent-drop rate on riding
  // the 24h free-text window, but the template it moved everything onto is
  // `festival_announcement` sent as category:'marketing' — and the per-recipient
  // MARKETING TEMPLATE FREQUENCY CAP is precisely what Meta rejects with
  // "healthy ecosystem engagement", the string in that diagnosis. The old fix
  // named the wrong cause and moved owner alerts onto the one channel Meta rate
  // limits hardest. On 2026-07-28 a vendor opened the EFT bank details and the
  // master alert never arrived; that is this bug.
  //
  // A free-text message inside the 24h service window is not template-capped at
  // all. It also keeps newlines and *bold*, so the alert arrives readable
  // instead of as one flattened ' · ' blob.
  //
  // The window closes after 24h of admin silence, and canSend reports that as
  // `skipped` rather than throwing — so the template stays as the fallback and
  // nothing is lost when it does. `sendText` also runs the pre-send sanitiser,
  // which the template path skips.
  const textBody = `*${args.event.replace(/_/g, ' ').toUpperCase()}*\n\n${args.body}`
  let sent = false
  let sentBody = logBody
  let messageId: string | null = null
  let failure: string | null = null

  try {
    const t = await sendText(e164, textBody)
    if (!t.skipped) { sent = true; sentBody = textBody; messageId = t.messageId || null }
    else failure = t.skipped
  } catch (e) {
    failure = (e as Error).message
  }

  if (!sent) {
    try {
      const res = await sendTemplate(e164, 'festival_announcement', [firstName, logBody], { category: 'marketing' })
      if (!res.skipped) { sent = true; messageId = res.messageId || null; failure = null }
      else failure = res.skipped
    } catch (e) {
      failure = (e as Error).message
      console.error('[notify] deliver failed', admin.name, failure)
    }
  }

  await db.from('wa_messages').insert({
    direction: 'out',
    wa_phone: e164,
    body: sentBody,
    status: sent ? 'sent' : 'failed',
    provider_message_id: messageId,
    error: sent ? null : failure,
  }).then(() => {}, () => {}) // logging must never break the alert

  // Email backstop: WhatsApp owner alerts get frequency-capped by Meta and drop
  // silently (the failure is async, set later by a status webhook), so the WA
  // send above can never be trusted as delivered. For actionable events we ALSO
  // email the admin so the ping always lands. Best-effort, never throws.
  // Master (Taona) has no email in BOT_ADMINS by design, so in EFT mode the
  // festival-owner mute would leave critical alerts with NO non-Meta delivery
  // path (Meta drops ~86% of owner templates silently). Fall back to the EFT
  // admin's monitored CTH address so payment_failed / system_alert never vanish.
  const backstopTo = admin.email || fallbackEmail
  if (EMAIL_BACKSTOP_EVENTS.has(args.event) && backstopTo) {
    try {
      const label = args.event.replace(/_/g, ' ')
      await sendEmail({
        to: backstopTo,
        subject: `[YAH] ${label}: ${args.body.split('\n')[0].slice(0, 80)}`,
        text: `${args.body}\n\nOpen the admin inbox to action this: https://cthalaal.co.za/admin/bot-inbox`,
      })
    } catch (e) {
      console.error('[notify] email backstop failed', admin.name, (e as Error).message)
    }
  }
}

/** Pure target selection for an owner alert. Extracted so the routing rules are
 *  unit-testable without the WhatsApp/email/DB side effects.
 *  - `eftContent` true => the festival owner (Samreen) is NEVER a target, in any
 *    mode: any alert whose body mentions EFT is walled off from her (Taona
 *    2026-07-24, "anything that mentions eft must be auto excluded from samreen").
 *    The master still receives it under an 'all'/'master' audience. */
export function selectNotifyTargets(
  admins: BotAdmin[],
  opts: { audience: 'all' | 'master' | 'festival_owner'; excludeNorm: string | null; eftContent: boolean },
): BotAdmin[] {
  return admins.filter((a) => {
    if (opts.excludeNorm && toE164(a.phone) === opts.excludeNorm) return false
    if (opts.eftContent && a.role === 'festival_owner') return false
    // THE MIRROR. Taona 2026-07-28: "make sure I have a mirror of what goes to
    // samreen". The master is a target of every alert, whatever the audience, so
    // there is no message she receives that he does not. Placed ABOVE the
    // audience switch rather than inside it so a future audience value cannot
    // cut him out by forgetting to name him. `exclude` still wins (it is how we
    // skip the admin who just replied to their own message).
    if (a.role === 'master') return true
    // Everyone below is NOT the master, so a 'master' audience excludes them.
    if (opts.audience === 'all') return true
    if (opts.audience === 'festival_owner') return a.role === 'festival_owner'
    return false
  })
}

export async function notifyOwners(args: NotifyArgs): Promise<void> {
  // The festival owner (Samreen) is withheld ONLY from EFT-scoped alerts, NOT
  // blanket-muted during EFT mode (Taona 2026-07-25). She keeps every non-EFT
  // alert (new application, contract signed, a PAID vendor needing a human, a
  // Yoco-settled payment). An alert is EFT-scoped when its body mentions EFT OR
  // the caller flags it (eftScoped) — e.g. a support message from an unpaid /
  // collected master-lane vendor, whose body carries no "EFT" text.
  const eftOn = await getEftMode()
  const vendor = args.vendorId || args.vendorPhone
    ? await lookupVendorLane(args.vendorId, args.vendorPhone)
    : null
  const eftContent = isEftScopedAlert(args, vendor, eftOn)
  const audience = args.audience || 'all'
  const excludeNorm = args.exclude ? toE164(args.exclude) : null
  const targets = selectNotifyTargets(BOT_ADMINS, { audience, excludeNorm, eftContent })
  // Routing is otherwise unobservable: a wrongly-muted alert produces no error and
  // no trace, so the only way it surfaces is an admin noticing an absence weeks
  // later. Log the decision, and warn loudly when an alert reaches NOBODY.
  console.log(JSON.stringify({
    at: 'notify', event: args.event, eftContent, hadVendor: !!vendor,
    resolvedVendor: args.vendorId ? !!vendor : undefined,
    targets: targets.map((t) => t.role),
  }))
  if (targets.length === 0) {
    console.warn(JSON.stringify({ at: 'notify', warn: 'no_targets', event: args.event, audience, eftContent }))
  }
  // Master has no email in BOT_ADMINS (festival ops mail must not route to an
  // agency address), so give its backstop a home at the EFT admin's monitored
  // CTH inbox. This was gated on `eftOn`, which meant that with global EFT mode
  // off the master had exactly ONE delivery path, WhatsApp, on a channel Meta
  // drops silently. Ungated: dev@cthalaal.co.za is a CTH address, so this is
  // within the project-isolation rule in either mode.
  const fallbackEmail = EFT_ADMIN_EMAIL
  await Promise.all(targets.map((a) => deliverOne(a, args, fallbackEmail)))
}
