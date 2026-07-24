// Unified inbox reply — send to a contact on WhatsApp or email from one box.
//
// WhatsApp:
//   - mode 'text' (default): sendText, which runs the canSend consent/window
//     gate. Free-form is allowed only inside the 24h session window. If the
//     window is closed we return 409 with windowClosed:true so the client can
//     offer a template send instead of leaving the operator stuck.
//   - mode 'template': sends the approved free-text marketing template
//     (festival_announcement) so the team CAN reach a vendor who went quiet
//     more than 24h ago. This is the Meta-compliant way out of the window.
// Email: threads into the recipient's existing conversation (Re: subject +
//   In-Reply-To/References) so it lands in their thread, not a new disconnected
//   message. sendEmail mirrors it into the Support Inbox too.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendText, sendTemplate, sendMedia, toE164 } from '@/lib/whatsapp'
import { sendEmail } from '@/lib/email/resend'
import { transportFor, fromAddressFor } from '@/lib/email-concierge'
import { mirrorOutboundToSupportInbox } from '@/lib/email/support-mirror'
import { assertRole } from '@/lib/admin-rbac'
import { mentionsEft, markVendorToldEft } from '@/lib/eft'
import { z } from 'zod'

/**
 * Which mailbox does this peer's conversation live on? The two inbound
 * fetchers tag support_inbox_messages.mailbox ('gmail' for Samreen's
 * capetownhalaal@gmail.com, unset/null for support@youngatheart.co.za — see
 * mail-fetcher.ts / support-mail-fetcher.ts). A reply must go out from the
 * SAME mailbox the vendor actually emailed, or it lands as a from-mismatch
 * (Taona 2026-07-12: "it must know which email to reply from"). We read the
 * peer's most recent INBOUND message rather than a static thread column,
 * since that is the freshest signal of where they expect the reply.
 */
async function mailboxForPeer(db: ReturnType<typeof createAdminClient>, peerEmail: string): Promise<'gmail' | 'primary'> {
  const { data } = await db
    .from('support_inbox_messages')
    .select('mailbox')
    .eq('direction', 'in')
    .ilike('from_address', peerEmail)
    .order('received_at', { ascending: false })
    .limit(1)
  const row = data?.[0] as { mailbox?: string | null } | undefined
  return row?.mailbox === 'gmail' ? 'gmail' : 'primary'
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  channel: z.enum(['whatsapp', 'email']),
  mode: z.enum(['text', 'template']).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(160).optional(),
  text: z.string().max(4000).optional(),
  subject: z.string().max(200).optional(),
  // Optional attachment (~4.5MB binary). Email -> Resend attachment; WhatsApp ->
  // uploaded + sent as a media message (in-window only).
  attachment: z.object({
    filename: z.string().min(1).max(200),
    contentType: z.string().min(1).max(120),
    dataBase64: z.string().min(1).max(6_000_000),
  }).optional(),
})

async function firstNameForPhone(db: ReturnType<typeof createAdminClient>, e164: string): Promise<string> {
  const noPlus = e164.replace(/^\+/, '')
  const { data } = await db
    .from('vendor_applications')
    .select('contact_name, business_name')
    .or(`phone.eq.+${noPlus},phone.eq.${noPlus}`)
    .limit(1)
  const name = (data?.[0]?.contact_name || data?.[0]?.business_name || '').trim()
  return name ? name.split(/\s+/)[0] : 'there'
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, email').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Role gate. This route SENDS a live WhatsApp/email reply to a vendor —
  // a viewer session must not be able to do this. Only owner/operator.
  try {
    await assertRole(user.id, ['owner', 'operator'])
  } catch {
    return NextResponse.json({ error: 'insufficient_role' }, { status: 403 })
  }

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'invalid body', details: e.issues }, { status: 400 })
    throw e
  }

  if (!body.text?.trim() && !body.attachment) {
    return NextResponse.json({ error: 'text or attachment required' }, { status: 400 })
  }
  const text = body.text?.trim() || ''

  if (body.channel === 'whatsapp') {
    if (!body.phone) return NextResponse.json({ error: 'phone required' }, { status: 400 })
    const e164 = toE164(body.phone)

    // Attachment path: upload + send as a media message (in-window only).
    if (body.attachment) {
      const kind: 'image' | 'document' = body.attachment.contentType.startsWith('image/') ? 'image' : 'document'
      const res = await sendMedia(e164, {
        bytes: Buffer.from(body.attachment.dataBase64, 'base64'),
        mimeType: body.attachment.contentType,
        filename: body.attachment.filename,
        caption: text || undefined,
        kind,
      })
      if (res.skipped) {
        const windowClosed = res.skipped.includes('window')
        return NextResponse.json({ ok: false, channel: 'whatsapp', reason: res.skipped, windowClosed, message: windowClosed ? 'Outside the 24h window, so a file cannot be sent. They need to message first.' : `Could not send file: ${res.skipped}` }, { status: 409 })
      }
      await db.from('wa_messages').insert({
        direction: 'out',
        wa_phone: e164.replace(/^\+/, ''),
        body: text || `[file: ${body.attachment.filename}]`,
        status: 'sent',
        provider_message_id: res.messageId || null,
        metadata: { sent_by: adminUser.email, attachment: body.attachment.filename },
      })
      return NextResponse.json({ ok: true, channel: 'whatsapp', via: 'media' })
    }

    // Template path: reach a contact who is outside the 24h window.
    if (body.mode === 'template') {
      const firstName = await firstNameForPhone(db, e164)
      const res = await sendTemplate(e164, 'festival_announcement', [firstName, text], { category: 'marketing' })
      if (res.skipped) {
        return NextResponse.json({ ok: false, channel: 'whatsapp', reason: res.skipped, message: `Could not send template: ${res.skipped}` }, { status: 409 })
      }
      await db.from('wa_messages').insert({
        direction: 'out',
        wa_phone: e164.replace(/^\+/, ''),
        body: text,
        template_name: 'festival_announcement',
        status: 'sent',
        provider_message_id: res.messageId || null,
        metadata: { sent_by: adminUser.email, via: 'template' },
      })
      return NextResponse.json({ ok: true, channel: 'whatsapp', via: 'template' })
    }

    const res = await sendText(e164, text)
    if (res.skipped) {
      const windowClosed = res.skipped.includes('window')
      return NextResponse.json({
        ok: false,
        channel: 'whatsapp',
        reason: res.skipped,
        windowClosed,
        message: windowClosed
          ? 'Outside the 24h WhatsApp window, so a free-form reply is not allowed by Meta. Send it as an approved announcement template instead.'
          : `Could not send: ${res.skipped}`,
      }, { status: 409 })
    }
    await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: e164.replace(/^\+/, ''),
      body: text,
      status: 'sent',
      provider_message_id: res.messageId || null,
      metadata: { sent_by: adminUser.email },
    })
    // Told a vendor about EFT -> move their comms onto the Master lane.
    if (mentionsEft(text)) await markVendorToldEft({ phone: e164 })
    return NextResponse.json({ ok: true, channel: 'whatsapp' })
  }

  // email — thread into the recipient's existing conversation.
  if (!body.email) return NextResponse.json({ error: 'email required' }, { status: 400 })
  const peer = body.email.toLowerCase()
  const { data: threads } = await db
    .from('support_inbox_threads')
    .select('id, subject')
    .ilike('peer_email', peer)
    .order('last_handled_at', { ascending: false, nullsFirst: false })
    .limit(1)
  const thread = threads?.[0] as { id: string; subject: string | null } | undefined

  let subject = body.subject || thread?.subject || 'Young at Heart Festival'
  if (thread?.subject && !/^re:/i.test(subject)) subject = 'Re: ' + thread.subject.replace(/^re:\s*/i, '')

  let inReplyTo: string | undefined
  if (thread?.id) {
    const { data: lastMsg } = await db
      .from('support_inbox_messages')
      .select('message_id')
      .eq('thread_id', thread.id)
      .not('message_id', 'is', null)
      .order('received_at', { ascending: false })
      .limit(1)
    inReplyTo = (lastMsg?.[0]?.message_id as string | undefined) || undefined
  }

  const mailbox = await mailboxForPeer(db, peer)

  if (mailbox === 'gmail') {
    // Reply FROM Samreen's actual Gmail (capetownhalaal@gmail.com), the same
    // account already used to READ her inbox (GMAIL_IMAP_USER/GMAIL_APP_PASS,
    // an app password — works for SMTP send too, no new credential needed).
    const from = fromAddressFor('gmail')
    if (!from) {
      return NextResponse.json({ ok: false, channel: 'email', reason: 'gmail_not_configured', message: 'GMAIL_IMAP_USER is not set.' }, { status: 502 })
    }
    try {
      const t = transportFor('gmail')
      await t.sendMail({
        from, to: body.email, subject, text: text || ' ',
        ...(body.attachment
          ? { attachments: [{ filename: body.attachment.filename, content: Buffer.from(body.attachment.dataBase64, 'base64'), contentType: body.attachment.contentType }] }
          : {}),
        ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
      })
      // Resend's sendEmail mirrors into the Support Inbox automatically; the
      // raw nodemailer path here must do it explicitly so the reply appears
      // in the thread same as a support@ reply does.
      await mirrorOutboundToSupportInbox({ to: body.email, subject, text: text || ' ' })
      if (mentionsEft(text)) await markVendorToldEft({ email: body.email })
      return NextResponse.json({ ok: true, channel: 'email', via: 'gmail' })
    } catch (e) {
      const msg = (e as Error).message
      console.error('[unified/reply] gmail send failed:', msg)
      return NextResponse.json({ ok: false, channel: 'email', reason: msg, message: `Email failed: ${msg}` }, { status: 502 })
    }
  }

  const res = await sendEmail({
    to: body.email,
    subject,
    text: text || ' ',
    attachments: body.attachment
      ? [{ filename: body.attachment.filename, content: body.attachment.dataBase64, contentType: body.attachment.contentType }]
      : undefined,
    extraHeaders: inReplyTo ? { 'In-Reply-To': inReplyTo, 'References': inReplyTo } : undefined,
  })
  if (!res.ok) {
    return NextResponse.json({ ok: false, channel: 'email', reason: res.error, message: `Email failed: ${res.error}` }, { status: 502 })
  }
  if (mentionsEft(text)) await markVendorToldEft({ email: body.email })
  return NextResponse.json({ ok: true, channel: 'email', via: 'support' })
}
