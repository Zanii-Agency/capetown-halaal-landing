// =============================================================================
// CTH mass outreach sender — Resend ONLY.
//
// Why this exists alongside src/lib/email/resend.ts:
//   - resend.ts is the transactional channel (single-recipient confirmations,
//     approval letters, payment reminders). No agency BCC; the Support Inbox
//     Sent tab is the record of what went out.
//   - zanii-sender.ts is the bulk channel. Per-recipient unsubscribe, a stable
//     RFC-compliant Message-ID, no bcc fan-out, paced batching. All bulk blasts
//     (doc chases, payment reminders fan-out, contract reminders, allocation
//     notices, general announcements) go through this lane.
//
// Doctrine:
//   - From defaults to hello@youngatheart.co.za, falls back to support@ when
//     the friendly mailbox is not yet verified in Resend.
//   - Reply-to is ALWAYS support@youngatheart.co.za so inbound replies hit the
//     monitored mailbox, not a no-reply.
//   - Message-ID is uuid@event.youngatheart.co.za — needed for thread tracking
//     and inbound-IMAP reconciliation (mail_messages.message_id is UNIQUE).
//   - List-Unsubscribe carries BOTH a mailto: and an https://...?token=... so
//     Gmail's one-click unsubscribe works.
// =============================================================================

import { render } from '@react-email/components'
import { Resend } from 'resend'
import { randomUUID } from 'crypto'
import type { ReactElement } from 'react'

const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim()
const FROM_PRIMARY = (process.env.ZANII_FROM_PRIMARY || 'Young at Heart Festival <hello@youngatheart.co.za>').trim()
const FROM_FALLBACK = (process.env.ZANII_FROM_FALLBACK || 'Young at Heart Festival <support@youngatheart.co.za>').trim()
const REPLY_TO = 'support@youngatheart.co.za'
const MESSAGE_ID_DOMAIN = 'event.youngatheart.co.za'
const PUBLIC_SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://cthalaal.co.za').replace(/\/+$/, '')

let client: Resend | null = null
function getClient(): Resend | null {
  if (!RESEND_API_KEY) return null
  if (!client) client = new Resend(RESEND_API_KEY)
  return client
}

// Cache verified-domain check. A "hello@" friendly mailbox needs the same
// domain verified in Resend (DKIM record on youngatheart.co.za). We assume it
// is, and let the API return an error on send if not, then re-try from
// FROM_FALLBACK once per send. No daemon round-trips.
export type ZaniiSendResult = {
  ok: boolean
  providerMessageId?: string
  messageId?: string
  error?: string
  statusCode?: number
  fromUsed?: string
}

export interface ZaniiSendInput {
  to: string
  subject: string
  react?: ReactElement
  html?: string
  text?: string
  /** Per-recipient unsubscribe token (opaque, base64url). */
  unsubscribeToken?: string
  /** Extra headers (must not collide with reserved ones). */
  extraHeaders?: Record<string, string>
  /** Optional tags forwarded to Resend for analytics. */
  tags?: Array<{ name: string; value: string }>
}

function buildMessageId(): string {
  return `<${randomUUID()}@${MESSAGE_ID_DOMAIN}>`
}

function buildListUnsubscribe(token?: string): string {
  const mailto = `mailto:${REPLY_TO}?subject=unsubscribe`
  if (!token) return `<${mailto}>`
  const url = `${PUBLIC_SITE}/unsubscribe?token=${encodeURIComponent(token)}`
  return `<${mailto}>, <${url}>`
}

/**
 * Send one bulk message via Resend.
 *
 * Always returns a structured result. Callers (broadcast loops, cron sweepers)
 * should log result.providerMessageId + result.messageId into mail_messages so
 * inbound replies can be reconciled via In-Reply-To / References.
 */
export async function sendZaniiMail(input: ZaniiSendInput): Promise<ZaniiSendResult> {
  const resend = getClient()
  if (!resend) {
    return { ok: false, error: 'RESEND_API_KEY missing' }
  }

  let html = input.html
  if (!html && input.react) {
    html = await render(input.react)
  }
  const text = input.text

  const messageId = buildMessageId()
  const headers: Record<string, string> = {
    'Message-ID': messageId,
    'List-Unsubscribe': buildListUnsubscribe(input.unsubscribeToken),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'X-Mailer': 'Young at Heart Festival',
    ...(input.extraHeaders || {}),
  }

  const trySend = async (from: string) => {
    const common = {
      from,
      to: input.to,
      replyTo: REPLY_TO,
      subject: input.subject,
      headers,
      ...(input.tags && input.tags.length ? { tags: input.tags } : {}),
    }
    if (html) return resend.emails.send({ ...common, html })
    return resend.emails.send({ ...common, text: text || '' })
  }

  // Primary attempt.
  try {
    const r = await trySend(FROM_PRIMARY)
    const errObj = (r as { error?: { message?: string; statusCode?: number } }).error
    if (errObj) {
      const msg = errObj.message || ''
      const isVerifyError = /domain.*verif|not.*verified|from.*invalid|sender/i.test(msg)
      if (isVerifyError && FROM_PRIMARY !== FROM_FALLBACK) {
        const r2 = await trySend(FROM_FALLBACK)
        const errObj2 = (r2 as { error?: { message?: string; statusCode?: number } }).error
        if (errObj2) {
          return { ok: false, error: errObj2.message, statusCode: errObj2.statusCode, fromUsed: FROM_FALLBACK, messageId }
        }
        const data2 = (r2 as { data?: { id?: string } }).data
        return { ok: true, providerMessageId: data2?.id, messageId, fromUsed: FROM_FALLBACK }
      }
      return { ok: false, error: msg, statusCode: errObj.statusCode, fromUsed: FROM_PRIMARY, messageId }
    }
    const data = (r as { data?: { id?: string } }).data
    return { ok: true, providerMessageId: data?.id, messageId, fromUsed: FROM_PRIMARY }
  } catch (e) {
    return { ok: false, error: (e as Error).message, fromUsed: FROM_PRIMARY, messageId }
  }
}

/**
 * Pace generator — yields once every `intervalMs`. Use for the 4/sec mail pace.
 *   for (const recipient of audience) {
 *     await pacer(250) // 4/sec
 *     await sendZaniiMail(...)
 *   }
 */
export function pacer(intervalMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, intervalMs))
}

export const ZANII_SENDER_CONFIG = {
  FROM_PRIMARY,
  FROM_FALLBACK,
  REPLY_TO,
  MESSAGE_ID_DOMAIN,
  PUBLIC_SITE,
} as const
