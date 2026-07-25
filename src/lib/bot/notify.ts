// Push portal events to the admin allowlist on WhatsApp + log to the Bot Inbox.
// Keeps Samreen "in the loop in real time" per ask. Best-effort: a failure here
// never breaks the originating request — the caller catches+continues.
//
// Pattern source: project_nisria_notifications (lib/notify.ts). Same shape,
// reused here with our approved Meta templates.

import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { BOT_ADMINS, type BotAdmin } from '@/lib/bot/admins'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { getEftMode, EFT_ADMIN_EMAIL, mentionsEft } from '@/lib/eft'

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
  /** Mark this alert EFT-scoped so the festival owner (Samreen) is withheld even
   *  when the body does not literally mention "EFT" — e.g. a support message from
   *  an unpaid/collected master-lane vendor. Callers set this from the vendor's
   *  lane status (vendorCommsInEftLane). Non-EFT alerts leave it unset. */
  eftScoped?: boolean
}

// Logs every send to wa_messages so the Bot Inbox surfaces it next to admin
// replies — one feed for owner attention.
async function deliverOne(admin: BotAdmin, args: NotifyArgs, fallbackEmail?: string) {
  const db = createAdminClient()
  const e164 = toE164(admin.phone)
  const firstName = admin.name.split(/\s+/)[0]

  // ALWAYS use the approved template for owner alerts (KT #206651). Owner alerts
  // are business-initiated (a system event, not a reply to the admin's own
  // inbound), so riding the 24h free-text `sendText` branch just because the
  // admin happened to message the bot recently is what tripped Meta's pacing
  // throttle and dropped 86% of them. An approved template is not pacing-capped
  // the same way. The email backstop below covers the rest.
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

  try {
    const res = await sendTemplate(e164, 'festival_announcement', [firstName, logBody], { category: 'marketing' })
    await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: e164,
      body: logBody,
      status: res.skipped ? 'failed' : 'sent',
      provider_message_id: res.messageId || null,
      error: res.skipped || null,
    })
  } catch (e) {
    console.error('[notify] deliver failed', admin.name, (e as Error).message)
  }

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
    if (opts.audience === 'all') return true
    if (opts.audience === 'master') return a.role === 'master'
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
  const eftContent = mentionsEft(args.body) || args.eftScoped === true
  const audience = args.audience || 'all'
  const excludeNorm = args.exclude ? toE164(args.exclude) : null
  const targets = selectNotifyTargets(BOT_ADMINS, { audience, excludeNorm, eftContent })
  // Master has no email in BOT_ADMINS; under EFT mode give its email backstop a
  // home (the EFT admin's monitored CTH inbox) so a master-only alert still lands.
  const fallbackEmail = eftOn ? EFT_ADMIN_EMAIL : undefined
  await Promise.all(targets.map((a) => deliverOne(a, args, fallbackEmail)))
}
