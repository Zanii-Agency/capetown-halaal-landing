/**
 * Support mail fetcher — pulls UNSEEN mail from support@youngatheart.co.za
 * and lands it in support_inbox_threads / support_inbox_messages.
 *
 * Why a second fetcher (separate from /api/cron/mail-fetcher):
 *   - The existing mail-fetcher writes into mail_messages + wa_threads, which
 *     powers the unified Bot Inbox (vendor mail).
 *   - support@youngatheart.co.za carries festival-wide support: ticket
 *     buyers, vendors, partners, randoms. We want THAT thread surface to
 *     keep operator focus.
 *   - Same mailbox, same UNSEEN filter, but we mark a thread tag on insert
 *     and only touch the support_inbox_* tables.
 *
 * Idempotent on Message-ID. Failures leave UIDs UNSEEN for retry.
 * Vercel cron should call this every 2 minutes alongside mail-fetcher.
 */

import { NextResponse } from 'next/server'
import { ImapFlow, type FetchMessageObject } from 'imapflow'
import { simpleParser } from 'mailparser'
import { createAdminClient } from '@/lib/supabase/admin'
import { broadcastInboxRefresh } from '@/lib/inbox-realtime'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { captureAttachments } from '@/lib/email/attachments'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

interface FetcherReport {
  ok: boolean
  fetched: number
  written: number
  skipped: number
  errors: string[]
  host: string
  durationMs: number
}

interface VendorMatch {
  id: string
  business_name?: string | null
  contact_name?: string | null
  email?: string | null
  phone?: string | null
  admin_notes?: string | null
  paid_at?: string | null
}

async function findVendorByEmail(
  supabase: ReturnType<typeof createAdminClient>,
  email: string
): Promise<VendorMatch | null> {
  if (!email) return null
  const { data, error } = await supabase
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at')
    .eq('email', email)
    .limit(1)
  if (error || !data || data.length === 0) return null
  return data[0] as VendorMatch
}

interface BuyerMatch { email: string }

async function findBuyerByEmail(
  supabase: ReturnType<typeof createAdminClient>,
  email: string
): Promise<BuyerMatch | null> {
  if (!email) return null
  try {
    const { data, error } = await supabase
      .from('ticket_buyers')
      .select('email')
      .eq('email', email)
      .limit(1)
    if (error || !data || data.length === 0) return null
    return data[0] as BuyerMatch
  } catch { return null }
}

export async function GET(req: Request): Promise<NextResponse<FetcherReport>> {
  const started = Date.now()
  const errors: string[] = []
  let fetched = 0
  let written = 0
  let skipped = 0

  // Fail-closed cron gate (verifyCronAuth returns false when CRON_SECRET is
  // unset), so this IMAP-reading route is never publicly triggerable.
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json(
      { ok: false, fetched: 0, written: 0, skipped: 0, errors: ['unauthorized'], host: '', durationMs: 0 },
      { status: 401 }
    )
  }

  const host = process.env.IMAP_HOST || 'imap.secureserver.net'
  const port = Number(process.env.IMAP_PORT || 993)
  const user = process.env.IMAP_USER || 'support@youngatheart.co.za'
  let pass = process.env.IMAP_PASS
  if (!pass) pass = process.env.SMTP_PASS
  if (!pass) {
    return NextResponse.json(
      { ok: false, fetched: 0, written: 0, skipped: 0, errors: ['no IMAP/SMTP password configured'], host, durationMs: Date.now() - started },
      { status: 500 }
    )
  }

  const supabase = createAdminClient()
  const client = new ImapFlow({
    host, port, secure: true, auth: { user, pass }, logger: false, socketTimeout: 30_000,
  })

  try {
    await client.connect()
  } catch (e) {
    try { await client.close() } catch { /* swallow */ }
    return NextResponse.json(
      { ok: false, fetched: 0, written: 0, skipped: 0, errors: [`imap connect: ${(e as Error).message}`], host, durationMs: Date.now() - started },
      { status: 502 }
    )
  }

  let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | null = null
  try {
    lock = await client.getMailboxLock('INBOX')
    const uidsRaw = await client.search({ seen: false }, { uid: true })
    const uids: number[] = Array.isArray(uidsRaw) ? uidsRaw : []
    const toFetch = uids.slice(0, 50)

    for (const uid of toFetch) {
      fetched += 1
      let msg: FetchMessageObject | null = null
      try {
        msg = (await client.fetchOne(String(uid), {
          envelope: true,
          source: true,
          headers: ['message-id', 'auto-submitted', 'x-auto-response-suppress', 'precedence', 'in-reply-to'],
        }, { uid: true })) as FetchMessageObject
      } catch (e) {
        errors.push(`uid ${uid} fetch: ${(e as Error).message}`)
        skipped += 1
        continue
      }
      if (!msg) { skipped += 1; continue }

      const headerBlob = msg.headers ? msg.headers.toString('utf8') : ''
      const autoSubmittedMatch = headerBlob.match(/^auto-submitted:\s*([^\r\n]+)/im)
      const autoSubmitted = autoSubmittedMatch !== null && autoSubmittedMatch[1].trim().toLowerCase() !== 'no'
      const autoSuppress = /^x-auto-response-suppress:\s*\S/im.test(headerBlob)
      const precedence = /^precedence:\s*(bulk|list|junk)/im.test(headerBlob)
      if (autoSubmitted || autoSuppress || precedence) {
        try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) } catch { /* swallow */ }
        skipped += 1
        continue
      }

      const messageIdMatch = headerBlob.match(/^message-id:\s*(.+)$/im)
      const messageId = (messageIdMatch?.[1] || msg.envelope?.messageId || '').trim()
      if (!messageId) { skipped += 1; continue }

      const inReplyToMatch = headerBlob.match(/^in-reply-to:\s*(.+)$/im)
      const inReplyTo = inReplyToMatch?.[1]?.trim() || null

      const fromRaw = msg.envelope?.from?.[0]
      const fromAddrRaw = fromRaw?.address || ''
      const fromAddress = fromAddrRaw.toLowerCase()
      const fromName = fromRaw?.name || null
      const toAddress = (msg.envelope?.to?.[0]?.address || user).toLowerCase()
      const subject = msg.envelope?.subject || ''
      const receivedAt = (msg.envelope?.date || new Date()).toISOString()
      // N5: parse the MIME body, store ONLY text/plain (capped at 4KB).
      // Previously we kept up to 16KB of raw RFC822 source per email which
      // bloated the DB once we crossed a few thousand support threads.
      // Falls back to a sliced raw on parse error so we never lose the row.
      let body = ''
      let bodyHtml: string | null = null
      let parsedAttachments: import('@/lib/payments/email-proof-detect').ProofAttachment[] = []
      if (msg.source instanceof Buffer) {
        try {
          const parsed = await simpleParser(msg.source)
          parsedAttachments = (parsed.attachments || []) as import('@/lib/payments/email-proof-detect').ProofAttachment[]
          const txt = (parsed.text || '').trim()
          body = txt.slice(0, 4000)
          // Capture HTML alternative so the support-inbox renderer can
          // sanitize+display rich formatting instead of leaking raw markup
          // into whitespace-pre-wrap. Capped at 32KB so DB doesn't bloat.
          const html = typeof parsed.html === 'string' ? parsed.html.trim() : ''
          if (html) bodyHtml = html.slice(0, 32_000)
          // Fallback when the sender shipped HTML-only (no text alternative)
          // OR mailparser returned empty text: strip the headers off the raw
          // source instead of dumping RFC822 to the operator. The body starts
          // after the first blank line in MIME format.
          if (!body) {
            const raw = msg.source.toString('utf8')
            const splitIdx = raw.search(/\r?\n\r?\n/)
            const tail = splitIdx >= 0 ? raw.slice(splitIdx + 2).trim() : raw.trim()
            body = tail.slice(0, 4000)
          }
          // Real attachments (not embedded signature images) — uploaded to
          // Storage, appended to body as a marker so the unified inbox can
          // render them the same way it already does for WhatsApp media.
          body += await captureAttachments(supabase, messageId || `${uid}`, parsed.attachments)
        } catch (e) {
          errors.push(`mailparser ${messageId}: ${(e as Error).message}`)
          // Same header-strip path on parser failure so we never persist
          // the raw RFC822 envelope as the visible body.
          const raw = msg.source.toString('utf8')
          const splitIdx = raw.search(/\r?\n\r?\n/)
          const tail = splitIdx >= 0 ? raw.slice(splitIdx + 2).trim() : raw.trim()
          body = tail.slice(0, 4000)
        }
      }

      // Skip mail FROM the support address itself (sent-mail loops).
      if (fromAddress === user.toLowerCase()) {
        try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) } catch { /* swallow */ }
        skipped += 1
        continue
      }

      const vendor = await findVendorByEmail(supabase, fromAddress)
      const buyer = vendor ? null : await findBuyerByEmail(supabase, fromAddress)

      // EMAILED PROOF OF PAYMENT -> master lane, automatically (Taona 2026-08-02:
      // "if vendor emails proof of payment or via whatsapp, it should
      // autopopulate on masterlane if it isnt acknowledged"). Same flow as the
      // WhatsApp path: lane them first (recordEftProof refuses non-lane vendors),
      // then record the proof — which stamps eft_submitted_at, puts them on
      // /admin/eft, alerts the master with a copy, and acks the vendor.
      // Best-effort: a failure here must never block the inbox ingest.
      if (vendor && !vendor.paid_at && parsedAttachments.length) {
        try {
          const { looksLikeProofEmail, pickProofAttachment } = await import('@/lib/payments/email-proof-detect')
          const { vendorInEftLane, getEftMode, markVendorToldEft } = await import('@/lib/eft')
          const alreadyLane = vendorInEftLane(vendor.admin_notes || '', await getEftMode(), vendor.paid_at, { email: vendor.email, phone: vendor.phone })
          if (looksLikeProofEmail({ subject, body, attachments: parsedAttachments, alreadyLane })) {
            const att = pickProofAttachment(parsedAttachments)
            if (att?.content) {
              if (!alreadyLane) await markVendorToldEft({ email: vendor.email, phone: vendor.phone })
              const { recordEftProof } = await import('@/lib/payments/eft-proof-shared')
              const fresh = await findVendorByEmail(supabase, fromAddress)
              const result = await recordEftProof({
                applicationId: vendor.id,
                admin_notes: fresh?.admin_notes ?? vendor.admin_notes ?? null,
                paid_at: vendor.paid_at ?? null,
                email: vendor.email ?? null,
                phone: vendor.phone ?? null,
                business_name: vendor.business_name ?? null,
                contact_name: vendor.contact_name ?? null,
                file: { bytes: att.content, name: att.filename || 'proof-of-payment', type: att.contentType },
                note: `emailed proof of payment (subject: "${subject.slice(0, 120)}")`,
                source: 'email',
                // Capture even a card-only ⟦NOEFT⟧ vendor's emailed proof rather
                // than 403 + drop it. Storage only; no lane marker, Samreen wall
                // untouched. Matches the WhatsApp path.
                captureRegardless: true,
              })
              if (!result.ok) errors.push(`eft-proof ${fromAddress}: ${result.error}`)
            }
          }
        } catch (e) {
          errors.push(`eft-proof ${fromAddress}: ${(e as Error).message}`)
        }
      }

      // Upsert thread keyed on peer_email.
      let threadId: string | null = null
      try {
        const { data: existing } = await supabase
          .from('support_inbox_threads')
          .select('id,unread_count')
          .eq('peer_email', fromAddress)
          .maybeSingle()

        if (existing) {
          threadId = (existing as { id: string }).id
          const prevUnread = (existing as { unread_count: number }).unread_count ?? 0
          await supabase
            .from('support_inbox_threads')
            .update({
              peer_name: fromName,
              subject,
              status: 'open',
              snoozed_until: null,
              last_inbound_at: receivedAt,
              unread_count: prevUnread + 1,
              vendor_application_id: vendor?.id ?? null,
            })
            .eq('id', threadId)
        } else {
          const { data: inserted, error: insErr } = await supabase
            .from('support_inbox_threads')
            .insert({
              peer_email: fromAddress,
              peer_name: fromName,
              subject,
              status: 'open',
              last_inbound_at: receivedAt,
              unread_count: 1,
              vendor_application_id: vendor?.id ?? null,
            })
            .select('id')
            .single()
          if (insErr) throw insErr
          threadId = (inserted as { id: string }).id
        }
      } catch (e) {
        errors.push(`thread upsert ${fromAddress}: ${(e as Error).message}`)
        continue
      }

      // Insert message row, idempotent on message_id.
      try {
        const { error: msgErr } = await supabase
          .from('support_inbox_messages')
          .insert({
            thread_id: threadId,
            direction: 'in',
            from_address: fromAddress,
            from_name: fromName,
            to_address: toAddress,
            subject,
            body_text: body,
            body_html: bodyHtml,
            message_id: messageId,
            in_reply_to: inReplyTo,
            provider: 'imap',
            received_at: receivedAt,
          })
        if (msgErr) {
          const code = (msgErr as { code?: string }).code
          if (code !== '23505') {
            errors.push(`message insert ${messageId}: ${msgErr.message}`)
            continue
          }
        } else {
          written += 1
        }
      } catch (e) {
        errors.push(`message insert ${messageId}: ${(e as Error).message}`)
        continue
      }

      // Mirror to site_events as a lightweight timeline ping (best effort).
      try {
        await supabase.from('site_events').insert({
          session_id: 'support-inbox',
          event_type: 'support_mail_in',
          path: '/admin/support-inbox',
          metadata: {
            thread_id: threadId,
            from_address: fromAddress,
            subject,
            vendor_application_id: vendor?.id ?? null,
            ticket_buyer_email: buyer?.email ?? null,
          },
        })
      } catch { /* swallow */ }

      try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) }
      catch (e) { errors.push(`flag seen ${uid}: ${(e as Error).message}`) }
    }
  } catch (e) {
    errors.push(`loop: ${(e as Error).message}`)
  } finally {
    if (lock) { try { lock.release() } catch { /* swallow */ } }
    await client.logout().catch(async () => {
      try { await client.close() } catch { /* swallow */ }
    })
  }

  const durationMs = Date.now() - started
  // Heartbeat: emit a site_event on EVERY run, even when fetched=0. This makes
  // silent cron outages visible — if no heartbeat for >10 min, the cron is down.
  try {
    const supabaseHb = createAdminClient()
    await supabaseHb.from('site_events').insert({
      session_id: 'support-inbox-cron',
      event_type: 'support_mail_fetcher_heartbeat',
      path: '/api/cron/support-mail-fetcher',
      metadata: { fetched, written, skipped, errors_count: errors.length, host, durationMs },
    })
  } catch { /* swallow */ }

  // Live-update the open inboxes. Until 2026-07-26 the ONLY caller of this was
  // the WhatsApp webhook, so WhatsApp felt instant while email sat behind a 30s
  // client poll on top of this 2-minute cron — the same inbox behaving two
  // different ways, which is most of what "feels out of sync" meant. Only ping
  // when something actually landed. Best-effort, never throws.
  if (written > 0) await broadcastInboxRefresh('email').catch(() => {})

  return NextResponse.json({ ok: errors.length === 0, fetched, written, skipped, errors, host, durationMs })
}
