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
  const confirmer = EMAIL_CONFIRMER

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
    .select('id, received_at')
    .eq('concierge_status', 'awaiting_confirm')
    .eq('concierge_admin', confirmer.phone)
  const staleCutoff = Date.now() - STALE_MINUTES * 60 * 1000
  const stale = (inflightRows || []).filter((r) => new Date(r.received_at as string).getTime() < staleCutoff)
  const fresh = (inflightRows || []).filter((r) => new Date(r.received_at as string).getTime() >= staleCutoff)
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

  // Oldest NEW inbound email.
  const { data: rows } = await db
    .from('support_inbox_messages')
    .select('id, from_address, from_name, to_address, subject, body_text, message_id, concierge_draft')
    .eq('direction', 'in')
    .is('concierge_status', null)
    .order('received_at', { ascending: true })
    .limit(1)
  const r = rows?.[0] as Record<string, unknown> | undefined
  if (!r) return NextResponse.json({ ok: true, nothing: 'no new emails' })

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
  const box = email.account === 'gmail' ? 'capetownhalaal@gmail.com' : 'support@youngatheart.co.za'
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

  return NextResponse.json({
    ok: !r1.skipped && !r2.skipped,
    notified: confirmer.phone, email_id: email.id, from: email.from_address, drafted: Boolean(draft),
  })
}
