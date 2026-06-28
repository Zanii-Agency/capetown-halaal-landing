/**
 * Email concierge cron — picks up the oldest unprocessed inbound email, drafts a
 * reply with Claude, and WhatsApps the confirmer (Samreen) the email + the draft
 * as two bubbles. She replies SEND / SEND: <text> / SKIP (handled in the webhook).
 *
 * One email in-flight per confirmer: if she already has an awaiting_confirm email,
 * we wait (so the confirm is never ambiguous). Flag-gated by EMAIL_CONCIERGE.
 * Runs every 2 minutes via vercel.json.
 */
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { sendText } from '@/lib/whatsapp'
import {
  emailConciergeEnabled,
  draftReply,
  cleanEmailBody,
  EMAIL_CONFIRMER,
  type InboundEmail,
} from '@/lib/email-concierge'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const ACCOUNT_LABEL: Record<string, string> = {
  gmail: 'capetownhalaal@gmail.com',
  primary: 'support@youngatheart.co.za',
}

export async function GET(req: Request) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  if (!emailConciergeEnabled()) {
    return NextResponse.json({ ok: true, skipped: 'flag off (EMAIL_CONCIERGE)' })
  }

  const db = createAdminClient()
  const confirmer = EMAIL_CONFIRMER

  // One in-flight: if Samreen already has an email awaiting her confirm, wait.
  const { count: inflight } = await db
    .from('inbound_emails')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'awaiting_confirm')
    .eq('assigned_admin', confirmer.phone)
  if ((inflight ?? 0) > 0) {
    return NextResponse.json({ ok: true, waiting: 'an email is awaiting confirmation' })
  }

  // Oldest unprocessed inbound email.
  const { data: rows } = await db
    .from('inbound_emails')
    .select('id, account, from_address, from_name, to_address, subject, body, message_id, draft_reply, vendor_application_id')
    .eq('status', 'new')
    .order('received_at', { ascending: true })
    .limit(1)
  const email = (rows?.[0] as InboundEmail) || null
  if (!email) {
    return NextResponse.json({ ok: true, nothing: 'no new emails' })
  }

  // Draft the reply (best-effort; an empty draft still notifies, she SENDs her own).
  const draft = await draftReply(email)

  // Bubble 1: the incoming email.
  const box = ACCOUNT_LABEL[email.account] || email.account
  const snippet = cleanEmailBody(email.body).slice(0, 500)
  const bubble1 =
    `📧 New email on ${box}\n` +
    `From: ${email.from_name ? email.from_name + ' ' : ''}<${email.from_address}>\n` +
    `Subject: ${email.subject || '(no subject)'}\n\n` +
    `"${snippet}${snippet.length >= 500 ? '…' : ''}"`
  const r1 = await sendText(confirmer.phone, bubble1)

  // Bubble 2: the suggested reply + instructions.
  const bubble2 = draft
    ? `✍️ Suggested reply:\n\n${draft}\n\n— — —\nReply *SEND* to send this, *SEND: your own message* to change it, or *SKIP* to skip.`
    : `I couldn't auto-draft a reply for this one. Reply *SEND: your message* to send your wording, or *SKIP* to skip.`
  const r2 = await sendText(confirmer.phone, bubble2)

  // Mark awaiting confirm (store the draft + who confirms).
  await db.from('inbound_emails').update({
    status: 'awaiting_confirm',
    draft_reply: draft || null,
    assigned_admin: confirmer.phone,
    notified_at: new Date().toISOString(),
  }).eq('id', email.id)

  return NextResponse.json({
    ok: !r1.skipped && !r2.skipped,
    notified: confirmer.phone,
    email_id: email.id,
    from: email.from_address,
    drafted: Boolean(draft),
    sendSkips: [r1.skipped, r2.skipped].filter(Boolean),
  })
}
