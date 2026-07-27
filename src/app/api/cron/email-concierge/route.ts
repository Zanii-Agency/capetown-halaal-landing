/**
 * Email concierge cron — picks up the oldest NEW inbound email (from
 * support_inbox_messages, concierge_status IS NULL), drafts a reply with Claude,
 * and WhatsApps the confirmer (Samreen) the email + the draft as two bubbles.
 * She replies SEND / SEND: <text> / SKIP (handled in the webhook).
 *
 * One email in-flight per confirmer (so the confirm is never ambiguous).
 * Flag-gated by EMAIL_CONCIERGE. Runs every 2 minutes via vercel.json.
 * Existing emails were backfilled to 'skipped', so only NEW mail triggers this.
 */
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { sendText } from '@/lib/whatsapp'
import { emailConciergeEnabled, draftReply, accountForRow, EMAIL_CONFIRMER, EMAIL_MIRROR, type InboundEmail } from '@/lib/email-concierge'
import { getEftMode } from '@/lib/eft'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(req: Request) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  if (!emailConciergeEnabled()) {
    return NextResponse.json({ ok: true, skipped: 'flag off (EMAIL_CONCIERGE)' })
  }

  const db = createAdminClient()
  // Global EFT mode: route the confirm flow to the master (Taona), so support@
  // emails never ping the festival owner (Samreen). She still SEES paid vendors'
  // emails passively in the support inbox; only the active WhatsApp draft/confirm
  // moves to Taona. Reverts when EFT mode is off (Taona 2026-07-23).
  const eftOn = await getEftMode()
  const confirmer = eftOn ? EMAIL_MIRROR : EMAIL_CONFIRMER

  // One in-flight: if Samreen already has an email awaiting her confirm, wait
  // — UNLESS it's gone stale (found 2026-07-12: this had no timeout at all, so
  // a single row whose WhatsApp notify silently failed — the exact "healthy
  // ecosystem engagement" throttle this project already fights — blocked the
  // ENTIRE queue forever. 2 rows sat in awaiting_confirm since 2026-06-29;
  // 267 real inbound emails since then were never even looked at, including a
  // City of Cape Town event-support reply with a deadline that has now
  // passed). A stale in-flight row is auto-skipped (not silently discarded —
  // tagged so it's visible it was auto-resolved, not actioned) so the queue
  // can never wedge shut again; the operator still sees it via concierge_status.
  const STALE_MINUTES = 60
  const { data: inflightRows } = await db
    .from('support_inbox_messages')
    .select('id, received_at, created_at')
    .eq('concierge_status', 'awaiting_confirm')
    .eq('concierge_admin', confirmer.phone)
  const staleCutoff = Date.now() - STALE_MINUTES * 60 * 1000
  // Staleness is measured from when the email entered OUR system (created_at),
  // NOT from when the vendor sent it (received_at).
  //
  // On received_at, any email imported more than an hour after it was written
  // was stale the instant we asked about it, and got auto-skipped on the very
  // next 2-minute cron run. 2026-07-27: a vendor's payment problem arrived
  // 07:33, was imported 11:30 by the Gmail backfill, alerted, and was dead
  // before the operator's reply landed ONE MINUTE later. Every email that
  // backfill recovered was in the same position. The window is meant to stop
  // the queue wedging on an unanswered prompt, so it has to start when the
  // prompt was sent.
  const basis = (r: { created_at?: string | null; received_at?: string | null }) =>
    new Date((r.created_at || r.received_at) as string).getTime()
  const stale = (inflightRows || []).filter((r) => basis(r) < staleCutoff)
  const fresh = (inflightRows || []).filter((r) => basis(r) >= staleCutoff)
  if (stale.length > 0) {
    await db
      .from('support_inbox_messages')
      .update({ concierge_status: 'skipped_stale' })
      .in('id', stale.map((r) => r.id))
    console.warn(`[email-concierge] auto-skipped ${stale.length} stale in-flight row(s) (>${STALE_MINUTES}min unconfirmed) so the queue is not wedged shut`)
  }
  if (fresh.length > 0) {
    return NextResponse.json({ ok: true, waiting: 'an email is awaiting confirmation', autoSkippedStale: stale.length })
  }

  // VENDOR-ONLY: the WhatsApp draft/confirm flow fires only for emails whose
  // sender is a known vendor (matches a vendor_applications email exactly).
  // Marketing blasts, newsletters, and cold senders (e.g. an NPO fundraising
  // email from a communications@ address that is NOT the vendor's contact on
  // file) are bulk-marked skipped_nonvendor so they never ping WhatsApp and never
  // wedge the queue (Taona 2026-07-24: "only emails from vendors"). They remain
  // visible in the admin support inbox for manual handling.
  const BATCH = 25
  const { data: batch } = await db
    .from('support_inbox_messages')
    .select('id, from_address, from_name, to_address, subject, body_text, message_id, concierge_draft')
    .eq('direction', 'in')
    .is('concierge_status', null)
    .order('received_at', { ascending: true })
    .limit(BATCH)
  if (!batch?.length) return NextResponse.json({ ok: true, nothing: 'no new emails' })

  // Vendor email set (lowercased) — full column so case/format never breaks the
  // match. ~O(vendors) rows, negligible.
  const { data: vendorRows } = await db.from('vendor_applications').select('email')
  const vendorEmails = new Set((vendorRows || []).map((v) => String(v.email || '').trim().toLowerCase()).filter(Boolean))
  const isVendor = (addr: unknown) => vendorEmails.has(String(addr || '').trim().toLowerCase())

  const nonVendor = batch.filter((b) => !isVendor(b.from_address))
  if (nonVendor.length) {
    await db.from('support_inbox_messages')
      .update({ concierge_status: 'skipped_nonvendor' })
      .in('id', nonVendor.map((b) => b.id))
  }
  const r = batch.find((b) => isVendor(b.from_address)) as Record<string, unknown> | undefined
  if (!r) return NextResponse.json({ ok: true, nothing: 'no new vendor emails', skippedNonVendor: nonVendor.length })

  const email: InboundEmail = {
    id: String(r.id),
    account: accountForRow(r),
    from_address: String(r.from_address || ''),
    from_name: (r.from_name as string) ?? null,
    to_address: (r.to_address as string) ?? null,
    subject: (r.subject as string) ?? null,
    body: (r.body_text as string) ?? null,
    message_id: (r.message_id as string) ?? null,
    draft_reply: null,
  }

  // ATOMIC CLAIM (skeptic LOW #5): flip NULL -> awaiting_confirm for THIS row
  // only; if another concurrent cron already claimed it, no row comes back and
  // we stop, so the email is never double-notified.
  const { data: claimed } = await db
    .from('support_inbox_messages')
    .update({ concierge_status: 'awaiting_confirm', concierge_admin: confirmer.phone })
    .eq('id', email.id)
    .is('concierge_status', null)
    .select('id')
  if (!claimed?.length) return NextResponse.json({ ok: true, raced: 'claimed by another run' })

  const draft = await draftReply(email)

  // Sanitize attacker-controlled header fields before they hit WhatsApp, so a
  // crafted from-name/subject can't fake fields or the SEND/SKIP footer (#7b).
  const clean = (s: string | null, n: number) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  // Label from the actual RECIPIENT where we have one. The alert told the
  // operator this email was on support@ when it had been sent to the Gmail box,
  // so he searched the wrong tab for it. to_address is unambiguous; the mailbox
  // column is only the fallback.
  const toAddr = (email.to_address || '').toLowerCase()
  const box = toAddr.includes('capetownhalaal') ? 'capetownhalaal@gmail.com'
    : toAddr.includes('support@youngatheart') ? 'support@youngatheart.co.za'
    : email.account === 'gmail' ? 'capetownhalaal@gmail.com' : 'support@youngatheart.co.za'
  const snippet = clean(email.body, 500)
  const bubble1 =
    `📧 New email on ${box}\n` +
    `From: ${clean(email.from_name, 80)} <${clean(email.from_address, 120)}>\n` +
    `Subject: ${clean(email.subject, 140) || '(no subject)'}\n\n` +
    `"${snippet}${snippet.length >= 500 ? '…' : ''}"`
  const r1 = await sendText(confirmer.phone, bubble1)

  const bubble2 = draft
    ? `✍️ Suggested reply (AI draft, please check):\n\n${draft}\n\nReply SEND to send this, SEND: your own message to change it, or SKIP to skip.`
    : `I couldn't auto-draft a reply for this one. Reply SEND: your message to send your wording, or SKIP to skip.`
  const r2 = await sendText(confirmer.phone, bubble2)

  // If BOTH bubbles failed to deliver, REVERT the claim so the row isn't stuck
  // pending with no notification (skeptic HIGH #6b) — it retries next run.
  if (r1.skipped && r2.skipped) {
    await db.from('support_inbox_messages').update({ concierge_status: null, concierge_admin: null }).eq('id', email.id)
    return NextResponse.json({ ok: false, notifyFailed: [r1.skipped, r2.skipped] })
  }

  await db.from('support_inbox_messages').update({ concierge_draft: draft || null }).eq('id', email.id)

  // Mirror to Taona (FYI only; Samreen is handling/confirming). Best-effort, one
  // compact message so he sees every email come in without being the confirmer.
  // In EFT mode Taona IS the confirmer, so the mirror is redundant and would
  // mislabel ("Samreen is handling") — skip it.
  if (!eftOn) {
    try {
      const mirror =
        `👀 Mirror (Samreen is handling): email on ${box}\n` +
        `From: ${clean(email.from_name, 80)} <${clean(email.from_address, 120)}>\n` +
        `Subject: ${clean(email.subject, 140) || '(no subject)'}\n\n` +
        `"${snippet.slice(0, 350)}"` +
        (draft ? `\n\nDraft: ${draft.slice(0, 450)}` : '')
      await sendText(EMAIL_MIRROR.phone, mirror)
    } catch (e) {
      console.warn('[email-concierge] mirror to Taona failed:', (e as Error).message)
    }
  }

  return NextResponse.json({
    ok: !r1.skipped && !r2.skipped,
    notified: confirmer.phone, email_id: email.id, from: email.from_address, drafted: Boolean(draft),
  })
}
