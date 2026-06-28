/**
 * Email -> WhatsApp reply loop ("email concierge").
 *
 * Flow: a new inbound_emails row (status='new') is picked up by the
 * email-concierge cron, which drafts a reply with Claude and WhatsApps the
 * confirmer (Samreen) the email + the draft. The webhook intercepts her reply:
 *   SEND            -> send the draft as-is
 *   SEND: <text>    -> send her wording instead
 *   SKIP / IGNORE   -> mark handled, send nothing
 * Sends go out via SMTP from the SAME mailbox the email arrived on (her Gmail
 * for account='gmail', the GoDaddy support box for account='primary').
 *
 * SAFETY: this SENDS real email on the festival's behalf, so it is flag-gated
 * (EMAIL_CONCIERGE) and NEVER sends on a free-text reply — only the explicit
 * SEND / SEND:/ SKIP verbs. One email is in-flight per confirmer at a time.
 */

import nodemailer from 'nodemailer'
import Anthropic from '@anthropic-ai/sdk'
import { createAdminClient } from '@/lib/supabase/admin'

export const EMAIL_CONFIRMER = { name: 'Samreen', phone: '+27723803393' }

export function emailConciergeEnabled(): boolean {
  return (process.env.EMAIL_CONCIERGE || '').toLowerCase() === 'on'
}

export interface InboundEmail {
  id: number
  account: string
  from_address: string
  from_name: string | null
  to_address: string | null
  subject: string | null
  body: string | null
  message_id: string | null
  draft_reply: string | null
  vendor_application_id: string | null
}

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null

function stripEmDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ', ').replace(/, ,/g, ',')
}

// The stored body is raw MIME (the fetcher keeps source until mailparser is
// wired). Pull a readable-ish plain-text slice for the LLM: drop the header
// block, drop obvious MIME boundary / Content-* lines, undo basic
// quoted-printable, collapse whitespace. Good enough for a draft Samreen reviews.
export function cleanEmailBody(raw: string | null): string {
  if (!raw) return ''
  let t = raw
  const split = t.indexOf('\r\n\r\n') >= 0 ? t.indexOf('\r\n\r\n') : t.indexOf('\n\n')
  if (split > 0) t = t.slice(split)
  t = t
    .split(/\r?\n/)
    .filter((l) => !/^(content-type|content-transfer-encoding|content-disposition|mime-version|--[-=_a-z0-9]+)/i.test(l.trim()))
    .join('\n')
  t = t.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  // strip a long HTML tail if present (keep text)
  t = t.replace(/<[^>]+>/g, ' ')
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000)
}

/** Draft a reply with Claude. Returns '' if no key / empty. */
export async function draftReply(email: InboundEmail): Promise<string> {
  if (!anthropic) return ''
  const system =
    `You draft email replies on behalf of the Cape Town Halaal Festival team (operator: Samreen). ` +
    `Tone: warm, professional, concise, helpful, South African English. ` +
    `NEVER use em-dashes (use commas, periods, colons). ` +
    `Do not invent facts, prices, or commitments you were not given. If you cannot answer something, write a short, friendly holding reply saying the team will look into it and follow up. ` +
    `End with a sign-off line: "Cape Town Halaal Festival Team". ` +
    `Output ONLY the reply body, no subject line, no "Here is a draft", no quotes.`
  const user =
    `Draft a reply to this email.\n` +
    `From: ${email.from_name || email.from_address} <${email.from_address}>\n` +
    `Subject: ${email.subject || '(no subject)'}\n\n` +
    `${cleanEmailBody(email.body)}`
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      temperature: 0.3,
      system,
      messages: [{ role: 'user', content: user }],
    })
    const text = r.content[0]?.type === 'text' ? r.content[0].text.trim() : ''
    return stripEmDashes(text)
  } catch (e) {
    console.error('[email-concierge] draft failed:', (e as Error).message)
    return ''
  }
}

function transportFor(account: string): nodemailer.Transporter {
  if (account === 'gmail') {
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_IMAP_USER || '', pass: process.env.GMAIL_APP_PASS || '' },
    })
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtpout.secureserver.net',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' },
  })
}

function fromAddressFor(account: string): string {
  return account === 'gmail' ? process.env.GMAIL_IMAP_USER || '' : process.env.SMTP_USER || ''
}

/** Send a reply via SMTP from the mailbox the email arrived on. */
export async function sendEmailReply(
  email: InboundEmail,
  replyText: string,
): Promise<{ ok: boolean; error?: string }> {
  const from = fromAddressFor(email.account)
  if (!from) return { ok: false, error: `no SMTP from-address for account ${email.account}` }
  const subjectRaw = email.subject || 'your message'
  const subject = /^re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`
  try {
    const t = transportFor(email.account)
    await t.sendMail({
      from,
      to: email.from_address,
      subject,
      text: stripEmDashes(replyText.trim()),
      ...(email.message_id ? { inReplyTo: email.message_id, references: email.message_id } : {}),
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** The email this admin is currently being asked to confirm (one in-flight). */
export async function pendingEmailForAdmin(adminPhone: string): Promise<InboundEmail | null> {
  const db = createAdminClient()
  const { data } = await db
    .from('inbound_emails')
    .select('id, account, from_address, from_name, to_address, subject, body, message_id, draft_reply, vendor_application_id')
    .eq('status', 'awaiting_confirm')
    .eq('assigned_admin', adminPhone)
    .order('received_at', { ascending: true })
    .limit(1)
  return (data?.[0] as InboundEmail) || null
}

/**
 * Interpret the confirmer's WhatsApp reply for a pending email.
 *   SEND            -> send the draft
 *   SEND: <text>    -> send her text
 *   SKIP/IGNORE/NO  -> skip
 *   anything else   -> NOT a send command (re-prompt; never sends blindly)
 */
export async function handleEmailConfirm(
  email: InboundEmail,
  rawText: string,
): Promise<{ reply: string; resolved: boolean }> {
  const db = createAdminClient()
  const t = (rawText || '').trim()
  const lower = t.toLowerCase()

  if (/^(skip|ignore|no|later|leave it|dismiss)\b/.test(lower)) {
    await db.from('inbound_emails').update({ status: 'skipped', handled_at: new Date().toISOString() }).eq('id', email.id)
    return { reply: `Skipped. I won't reply to ${email.from_name || email.from_address}. I'll bring you the next one.`, resolved: true }
  }

  // "send: <text>" or "send <text>" => her wording. Bare "send"/"yes"/"ok" => the draft.
  const m = t.match(/^send\s*[:\-]?\s*([\s\S]+)$/i)
  let bodyToSend: string | null = null
  if (/^(send|yes|ok|okay|approve|👍|👍🏽|go)\.?$/i.test(t)) {
    bodyToSend = email.draft_reply
  } else if (m && m[1].trim().length > 1) {
    bodyToSend = m[1].trim()
  }

  if (!bodyToSend) {
    return {
      reply: `To reply to ${email.from_name || email.from_address}: send *SEND* to send my draft, *SEND: your message* to send your own wording, or *SKIP* to skip.`,
      resolved: false,
    }
  }

  const res = await sendEmailReply(email, bodyToSend)
  if (!res.ok) {
    return { reply: `I couldn't send that email (${res.error}). Nothing went out. Try again or SKIP.`, resolved: false }
  }
  await db.from('inbound_emails').update({
    status: 'sent',
    draft_reply: bodyToSend,
    draft_sent_at: new Date().toISOString(),
    handled_at: new Date().toISOString(),
  }).eq('id', email.id)
  return { reply: `Sent to ${email.from_name || email.from_address} ✅. I'll bring you the next email when one comes in.`, resolved: true }
}
