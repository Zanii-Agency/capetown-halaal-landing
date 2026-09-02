import { render } from '@react-email/components'
import { Resend } from 'resend'
import type { ReactElement } from 'react'
import { logEmailOutbound } from '../outbound-log'

// =============================================================================
// CTH email — RESEND ONLY (2026-06-08).
//
// Why we ripped GoDaddy SMTP out:
//   - GoDaddy SMTP from the root domain has no DKIM signature on outbound;
//     mail consistently landed in Gmail Promotions / Spam for recipients on
//     major providers. Sam confirmed Global Cuisine approval went to spam.
//   - Resend signs every message with DKIM (`resend._domainkey`) aligned to
//     youngatheart.co.za, passes DMARC, reaches the inbox reliably.
//   - 415/415 vendor verification blast on 2026-06-04 went through Resend
//     successfully — empirical confirmation Resend is the only reliable
//     channel from this domain.
//   - Maintaining a fallback that lands in spam adds zero value (sender
//     reputation actually degrades when the same content hits spam often).
//
// CTH-DOCTRINE Law 5 (email-throttle) now applies to Resend rate limits, not
// SMTP. Resend free tier = 100/day; paid scales beyond. Resend's own client
// handles batching internally so we don't need pool/maxMessages config.
// =============================================================================

export const FROM_EMAIL = 'Young at Heart Festival <support@youngatheart.co.za>'
export const ADMIN_EMAIL = 'support@youngatheart.co.za'
// NOTE: outbound mail is no longer BCC'd to info@sinan.agency (2026-06-19). The
// portal Support Inbox (Sent tab) is the single source of truth for what went
// out — every send is mirrored there as a threaded message via support-mirror.

// Trim trailing newlines (Vercel env vars often have them).
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim()

let resendClient: Resend | null = null
export function getResend(): Resend | null {
  if (!RESEND_API_KEY) return null
  if (!resendClient) resendClient = new Resend(RESEND_API_KEY)
  return resendClient
}

const mailHeaders = {
  'X-Mailer': 'Young at Heart Festival',
  'List-Unsubscribe': '<mailto:support@youngatheart.co.za?subject=unsubscribe>',
}

export type SendResult = {
  ok: boolean
  provider?: 'resend'
  error?: string
  /** true when Resend accepted the send but its suppression list silently
   *  dropped the recipient (last_event=suppressed/bounced/complained/failed). */
  suppressed?: boolean
}

// Resend accepts a send ({data:{id}}) and THEN drops suppressed recipients —
// the accept is not a delivery (KT #206657: 3 demo emails "ok:true", all
// suppressed, none delivered). These last_event values mean the recipient
// will never see the mail.
const DEAD_EVENTS = new Set(['suppressed', 'bounced', 'complained', 'failed'])

/**
 * Poll the sent email's status until it leaves the queue (suppression shows
 * up within ~1-2s). Returns the dead event name, or null if the mail is on a
 * live path (sent/delivered/opened/... or still queued after our budget —
 * fail-open so a slow Resend API never turns real sends into false alarms).
 */
async function detectDeadDelivery(id: string): Promise<string | null> {
  const resend = getResend()
  if (!resend) return null
  for (const waitMs of [1500, 2000]) {
    await new Promise((r) => setTimeout(r, waitMs))
    try {
      const res = await resend.emails.get(id)
      const lastEvent = (res?.data as { last_event?: string } | null)?.last_event || ''
      if (DEAD_EVENTS.has(lastEvent)) return lastEvent
      if (lastEvent && lastEvent !== 'queued') return null // sent/delivered etc.
    } catch {
      return null // status API blip: fail open, the send itself succeeded
    }
  }
  return null
}

/**
 * Send a transactional email via Resend (DKIM-signed, inbox-safe).
 *
 * No SMTP fallback by design — see the doctrine block at the top of this file.
 * If Resend fails the call returns ok:false with the error so callers can
 * surface it (admin UI, audit log) instead of silently swallowing.
 */
export async function sendEmail({
  to,
  subject,
  react,
  text,
  attachments,
  replyTo,
  extraHeaders,
  confirmDelivery,
}: {
  to: string
  subject: string
  react?: ReactElement
  text?: string
  /** Optional file attachments. content can be a base64 string or a Buffer. */
  attachments?: Array<{ filename: string; content: string | Buffer; contentType?: string }>
  /** Optional per-send Reply-To override. Defaults to support@youngatheart.co.za. */
  replyTo?: string
  /** Optional extra headers (e.g. In-Reply-To / References) so a reply threads
   *  into the recipient's existing conversation instead of starting a new one. */
  extraHeaders?: Record<string, string>
  /** Verify the mail actually left Resend (costs ~1.5-3.5s). Use on critical
   *  single sends (password reset, badge/contract delivery) so a suppressed
   *  recipient surfaces as ok:false instead of a silent drop. Leave off for
   *  batch/cron sends where the latency multiplies. */
  confirmDelivery?: boolean
}): Promise<SendResult> {
  let html: string | undefined
  if (react) {
    html = await render(react)
  }

  const resend = getResend()
  if (!resend) {
    const error = 'RESEND_API_KEY missing, no email channel available'
    console.error(`Email FAILED for ${to} ("${subject}"): ${error}`)
    return { ok: false, error }
  }

  try {
    const common = {
      from: FROM_EMAIL,
      to,
      replyTo: replyTo || 'support@youngatheart.co.za',
      subject,
      headers: { ...mailHeaders, ...(extraHeaders || {}) },
      ...(attachments && attachments.length
        ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) }
        : {}),
    }
    const sendRes = html
      ? await resend.emails.send({ ...common, html })
      : await resend.emails.send({ ...common, text: text || '' })

    // Resend's client returns { data, error } rather than throwing on API
    // errors — surface a real failure instead of falsely reporting ok:true.
    if (sendRes?.error) {
      const msg = (sendRes.error as { message?: string }).message || String(sendRes.error)
      console.error(`Resend send FAILED for ${to} ("${subject}"): ${msg}`)
      return { ok: false, error: `resend: ${msg}` }
    }

    const providerMessageId = sendRes?.data?.id || undefined
    console.log(`Email sent via Resend to ${to}: ${subject}`)

    // Mirror into the Support Inbox as a threaded message (best-effort, never
    // blocks the send). Makes the Sent tab a real two-way surface and refreshes
    // any open admin inbox.
    await logEmailOutbound({ to, subject, html, text, providerMessageId })

    if (confirmDelivery && providerMessageId) {
      const dead = await detectDeadDelivery(providerMessageId)
      if (dead) {
        const error = `resend accepted but ${dead} the recipient (never delivered): ${to} is on Resend's suppression/bounce list`
        console.error(`Email DEAD for ${to} ("${subject}"): ${error}`)
        return { ok: false, provider: 'resend', error, suppressed: true }
      }
    }

    return { ok: true, provider: 'resend' }
  } catch (e) {
    const msg = (e as Error).message
    console.error(`Resend send FAILED for ${to} ("${subject}"): ${msg}`)
    return { ok: false, error: `resend: ${msg}` }
  }
}

/**
 * Verify Resend connectivity. Used by the /api/admin/email-health endpoint.
 * Returns the legacy shape with smtp fields removed.
 */
export async function verifyEmailTransport(): Promise<{
  resend: { ok: boolean; error?: string }
  resendKeySet: boolean
  fromEmail: string
}> {
  const result = {
    resend: { ok: false } as { ok: boolean; error?: string },
    resendKeySet: !!RESEND_API_KEY,
    fromEmail: FROM_EMAIL,
  }
  if (!RESEND_API_KEY) {
    result.resend.error = 'RESEND_API_KEY not set'
    return result
  }
  // The Resend SDK has no ping/verify endpoint; check by listing domains.
  try {
    const r = getResend()
    if (!r) throw new Error('client init failed')
    const domains = await r.domains.list()
    if ((domains as { data?: unknown })?.data !== undefined) {
      result.resend.ok = true
    } else {
      result.resend.error = 'unexpected response from resend.domains.list'
    }
  } catch (e) {
    result.resend.error = (e as Error).message
  }
  return result
}
