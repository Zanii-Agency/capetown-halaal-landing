/**
 * Gmail fetcher cron — pulls Samreen's capetownhalaal@gmail.com into the SAME
 * support_inbox_threads / support_inbox_messages tables the unified inbox reads,
 * so her Gmail shows up natively alongside support@ and WhatsApp.
 *
 * Why this and not the support-mail-fetcher: that one owns support@youngatheart
 * (consumes UNSEEN, marks seen). This one owns ONLY her personal Gmail and is
 * NON-DESTRUCTIVE — searches RECENT, never marks her mail read, and dedups on
 * message_id (with an existence check so re-seeing a recent message does NOT
 * re-increment the thread unread_count). Runs every 2 minutes via vercel.json.
 *
 * (Historical note: this route previously raced support@ with support-mail-fetcher
 * and wrote to a dead-end table. Now scoped to Gmail -> support_inbox_*.)
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
// 300, not 60. Connect and INBOX-lock alone cost ~20s against this mailbox, which
// left under 40s to fetch and parse 50 messages with full source: the loop was
// still running when the 60s ceiling killed it, so a run could do all that work
// and commit nothing. 300 is the same ceiling remediate-approved already uses.
export const maxDuration = 300

async function findVendorByEmail(
  supabase: ReturnType<typeof createAdminClient>,
  email: string
): Promise<{ id: string } | null> {
  if (!email) return null
  const { data } = await supabase.from('vendor_applications').select('id').eq('email', email).limit(1)
  return (data?.[0] as { id: string }) || null
}

/** Reject a hung promise so a silent stall becomes a loud, logged failure. */
function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>
}

/**
 * A pulse on every run, mirroring support-mail-fetcher. The Gmail fetcher wrote
 * NO heartbeat at all, so there was no record anywhere of it running, skipping,
 * or dying: the only way to notice was to spot that inbound mail had stopped.
 * No heartbeat for >10 minutes now means this cron is down.
 */
async function heartbeat(metadata: Record<string, unknown>) {
  try {
    await createAdminClient().from('site_events').insert({
      session_id: 'gmail-inbox-cron',
      event_type: 'gmail_mail_fetcher_heartbeat',
      path: '/api/cron/mail-fetcher',
      metadata,
    })
  } catch { /* swallow: a heartbeat must never break the fetch */ }
}

export async function GET(req: Request) {
  const started = Date.now()
  const errors: string[] = []
  let fetched = 0, written = 0, skipped = 0
  // Stage tracing. The 60s timeout produced NO output at all, not even from the
  // deadline that was supposed to abort connect at 15s, so the stall is not
  // where reasoning said it was. Log each stage as it is entered: the last line
  // printed before the timeout names the stage that hangs.
  const stage = (s: string) => console.log(JSON.stringify({ at: 'gmail-fetcher', stage: s, ms: Date.now() - started }))
  stage('entered')

  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ ok: false, errors: ['unauthorized'], durationMs: 0 }, { status: 401 })
  }

  const user = process.env.GMAIL_IMAP_USER
  const pass = process.env.GMAIL_APP_PASS
  if (!user || !pass) {
    // NOT ok. This returned `ok: true` until 2026-07-27, so a mailbox with no
    // credentials looked identical to a mailbox with no new mail: every 2 minutes
    // the cron went green while importing nothing. Samreen's Gmail was dark from
    // 24 Jul 16:29 to 27 Jul and nothing anywhere said so. A skip is an outage,
    // and an outage has to be loud.
    await heartbeat({ skipped: 'no_credentials', errors_count: 1, durationMs: Date.now() - started })
    return NextResponse.json(
      { ok: false, errors: ['GMAIL_IMAP_USER/GMAIL_APP_PASS not set'], durationMs: Date.now() - started },
      { status: 503 },
    )
  }

  stage('creds_present')
  const supabase = createAdminClient()
  stage('db_client_ready')
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false, socketTimeout: 30_000 })

  try {
    // HARD deadline around connect, because ImapFlow's socketTimeout governs an
    // ESTABLISHED socket and does nothing for a TCP handshake that never
    // completes. When the far end silently drops the SYN (Google greylisting an
    // egress IP, a revoked app password refused at the edge) connect() hangs
    // rather than throwing: the function is killed at maxDuration with no error,
    // no log, and no heartbeat. That is the exact shape of this outage, and it is
    // why the heartbeat added minutes earlier recorded nothing at all.
    stage('connecting')
    await withDeadline(client.connect(), 30_000, 'imap connect timed out after 30s')
    stage('connected')
  } catch (e) {
    stage('connect_failed:'+(e as Error).message)
    try { client.close() } catch { /* swallow */ }
    // The other silent death: a rejected app password fails HERE, and without a
    // heartbeat the outage is invisible for exactly as long as nobody looks.
    await heartbeat({ skipped: 'imap_connect_failed', error: (e as Error).message, errors_count: 1, durationMs: Date.now() - started })
    return NextResponse.json({ ok: false, errors: [`imap connect: ${(e as Error).message}`], durationMs: Date.now() - started }, { status: 502 })
  }

  let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | null = null
  try {
    stage('locking_inbox')
    lock = await withDeadline(client.getMailboxLock('INBOX'), 15_000, 'INBOX lock timed out after 15s')
    // NO SEARCH. This used `client.search({ since })`, and on 2026-07-27 the stage
    // trace caught it entering that call at 19.7s and never coming back: killed at
    // the 60s ceiling, every run, since 24 July. Gmail implements SEARCH SINCE as a
    // scan of the whole mailbox rather than an index hit, so on an account this
    // size it simply does not return inside a serverless function. Worse, it starves
    // the event loop while it waits, so neither the 20s deadline wrapped around it
    // nor ImapFlow's own 30s socketTimeout could fire. Three credible-looking
    // guards, none of which could ever have run.
    //
    // The newest N messages are the last N sequence numbers, which the SELECT
    // already told us for free. No search, no scan, constant work per run. The
    // 3-day window it used to buy is applied per message from the envelope date
    // below, which is a comparison we were doing anyway.
    const total = client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox.exists : 0
    const first = Math.max(1, total - 49)
    const toFetch = total > 0 ? Array.from({ length: total - first + 1 }, (_, i) => first + i) : []
    stage(`range_ready:${first}-${total}`)
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000

    // Wall-clock budget. A hard kill at maxDuration returns nothing, writes no
    // heartbeat and leaves no reason behind, which is exactly how this outage hid
    // for three days. Stop early instead and report what was done: the cron runs
    // every 2 minutes, so an unfinished backlog drains on the following runs.
    const budgetMs = 240_000
    // CHEAP PRE-PASS. This loop used to pull `source: true` (the FULL body) for
    // all 50 messages and only then check message_id against the database, so a
    // run with nothing new still downloaded and parsed 50 whole emails: 217
    // seconds of work to discover it already had everything. The cron fires
    // every 120s, so runs overlapped, and the overlapping IMAP connections timed
    // each other out. 20 consecutive runs failed that way. The fetcher was
    // DDoSing itself.
    //
    // Now: one streamed round trip for envelopes and headers only, one bulk
    // query to find which are already imported, and bodies fetched ONLY for the
    // genuinely new ones. A no-op run costs a couple of seconds.
    const heads = new Map<number, { messageId: string; headerBlob: string; date: number }>()
    try {
      for await (const m of client.fetch(`${first}:${total}`, {
        envelope: true,
        headers: ['message-id', 'auto-submitted', 'x-auto-response-suppress', 'precedence', 'in-reply-to'],
      })) {
        const blob = m.headers ? m.headers.toString('utf8') : ''
        const idMatch = blob.match(/^message-id:\s*(.+)$/im)
        heads.set(m.seq, {
          messageId: (idMatch?.[1] || m.envelope?.messageId || '').trim(),
          headerBlob: blob,
          date: m.envelope?.date ? new Date(m.envelope.date).getTime() : 0,
        })
      }
    } catch (e) {
      errors.push(`header sweep: ${(e as Error).message}`)
    }
    stage(`headers_ready:${heads.size}`)

    const ids = [...heads.values()].map((h) => h.messageId).filter(Boolean)
    const known = new Set<string>()
    if (ids.length) {
      const { data: existing } = await supabase
        .from('support_inbox_messages').select('message_id').in('message_id', ids)
      for (const r of (existing || []) as Array<{ message_id: string }>) known.add(r.message_id)
    }
    stage(`already_have:${known.size}/${ids.length}`)

    for (const seq of toFetch) {
      if (Date.now() - started > budgetMs) {
        errors.push(`budget: stopped after ${fetched} of ${toFetch.length} messages`)
        break
      }
      // Everything decidable from the headers is decided BEFORE paying for a body.
      const head = heads.get(seq)
      if (!head) { skipped += 1; continue }
      if (!head.messageId || known.has(head.messageId)) { skipped += 1; continue }
      if (head.date && head.date < cutoff) { skipped += 1; continue }
      const auto = head.headerBlob.match(/^auto-submitted:\s*([^\r\n]+)/im)
      if ((auto !== null && auto[1].trim().toLowerCase() !== 'no')
        || /^x-auto-response-suppress:\s*\S/im.test(head.headerBlob)
        || /^precedence:\s*(bulk|list|junk)/im.test(head.headerBlob)) { skipped += 1; continue }

      fetched += 1
      let msg: FetchMessageObject | null = null
      try {
        msg = (await client.fetchOne(String(seq), {
          envelope: true, source: true,
          headers: ['message-id', 'auto-submitted', 'x-auto-response-suppress', 'precedence', 'in-reply-to'],
        })) as FetchMessageObject
      } catch (e) { errors.push(`seq ${seq} fetch: ${(e as Error).message}`); skipped += 1; continue }
      if (!msg) { skipped += 1; continue }

      // The window the removed SEARCH used to enforce, now a date comparison.
      const sent = msg.envelope?.date ? new Date(msg.envelope.date).getTime() : 0
      if (sent && sent < cutoff) { skipped += 1; continue }

      const headerBlob = msg.headers ? msg.headers.toString('utf8') : ''
      const autoSubmittedMatch = headerBlob.match(/^auto-submitted:\s*([^\r\n]+)/im)
      const autoSubmitted = autoSubmittedMatch !== null && autoSubmittedMatch[1].trim().toLowerCase() !== 'no'
      const autoSuppress = /^x-auto-response-suppress:\s*\S/im.test(headerBlob)
      const precedence = /^precedence:\s*(bulk|list|junk)/im.test(headerBlob)
      if (autoSubmitted || autoSuppress || precedence) { skipped += 1; continue }

      const messageIdMatch = headerBlob.match(/^message-id:\s*(.+)$/im)
      const messageId = (messageIdMatch?.[1] || msg.envelope?.messageId || '').trim()
      if (!messageId) { skipped += 1; continue }

      // EXISTENCE CHECK (non-destructive correctness): if we've already imported
      // this message, skip BEFORE touching the thread, so unread_count is never
      // re-incremented on a re-read.
      const { data: dupe } = await supabase.from('support_inbox_messages').select('id').eq('message_id', messageId).limit(1)
      if (dupe && dupe.length) { skipped += 1; continue }

      const inReplyToMatch = headerBlob.match(/^in-reply-to:\s*(.+)$/im)
      const inReplyTo = inReplyToMatch?.[1]?.trim() || null

      const fromRaw = msg.envelope?.from?.[0]
      const fromAddress = (fromRaw?.address || '').toLowerCase()
      const fromName = fromRaw?.name || null
      const toAddress = (msg.envelope?.to?.[0]?.address || user).toLowerCase()
      const subject = msg.envelope?.subject || ''
      const receivedAt = (msg.envelope?.date || new Date()).toISOString()

      // Skip mail FROM her own address (sent-mail loops).
      if (fromAddress === user.toLowerCase()) { skipped += 1; continue }

      let body = ''
      let bodyHtml: string | null = null
      if (msg.source instanceof Buffer) {
        try {
          const parsed = await simpleParser(msg.source)
          body = (parsed.text || '').trim().slice(0, 4000)
          const html = typeof parsed.html === 'string' ? parsed.html.trim() : ''
          if (html) bodyHtml = html.slice(0, 32_000)
          if (!body) {
            const raw = msg.source.toString('utf8')
            const splitIdx = raw.search(/\r?\n\r?\n/)
            body = (splitIdx >= 0 ? raw.slice(splitIdx + 2) : raw).trim().slice(0, 4000)
          }
          // Real attachments (not embedded signature images) — see attachments.ts.
          body += await captureAttachments(supabase, messageId, parsed.attachments)
        } catch (e) { errors.push(`mailparser ${messageId}: ${(e as Error).message}`) }
      }

      const vendor = await findVendorByEmail(supabase, fromAddress)

      // Upsert thread by peer_email (mirrors support-mail-fetcher).
      let threadId: string | null = null
      try {
        const { data: existing } = await supabase.from('support_inbox_threads').select('id,unread_count').eq('peer_email', fromAddress).maybeSingle()
        if (existing) {
          threadId = (existing as { id: string }).id
          await supabase.from('support_inbox_threads').update({
            peer_name: fromName, subject, status: 'open', snoozed_until: null,
            last_inbound_at: receivedAt, unread_count: ((existing as { unread_count: number }).unread_count ?? 0) + 1,
            vendor_application_id: vendor?.id ?? null,
          }).eq('id', threadId)
        } else {
          const { data: inserted, error: insErr } = await supabase.from('support_inbox_threads').insert({
            peer_email: fromAddress, peer_name: fromName, subject, status: 'open',
            last_inbound_at: receivedAt, unread_count: 1, vendor_application_id: vendor?.id ?? null,
          }).select('id').single()
          if (insErr) throw insErr
          threadId = (inserted as { id: string }).id
        }
      } catch (e) { errors.push(`thread upsert ${fromAddress}: ${(e as Error).message}`); continue }

      try {
        const { error: msgErr } = await supabase.from('support_inbox_messages').insert({
          thread_id: threadId, direction: 'in', from_address: fromAddress, from_name: fromName,
          to_address: toAddress, subject, body_text: body, body_html: bodyHtml, message_id: messageId,
          in_reply_to: inReplyTo, provider: 'imap', mailbox: 'gmail', received_at: receivedAt,
        })
        if (msgErr) {
          const code = (msgErr as { code?: string }).code
          if (code !== '23505') { errors.push(`message insert ${messageId}: ${msgErr.message}`); continue }
        } else { written += 1 }
      } catch (e) { errors.push(`message insert ${messageId}: ${(e as Error).message}`); continue }
    }
  } catch (e) {
    errors.push(`loop: ${(e as Error).message}`)
  } finally {
    if (lock) { try { lock.release() } catch { /* swallow */ } }
    await client.logout().catch(async () => { try { await client.close() } catch { /* swallow */ } })
  }

  const durationMs = Date.now() - started
  console.log(JSON.stringify({ at: 'gmail-fetcher', event: 'run_complete', fetched, written, skipped, errorCount: errors.length, durationMs }))
  await heartbeat({ fetched, written, skipped, errors_count: errors.length, host: 'imap.gmail.com', durationMs })
  // See the note in support-mail-fetcher: email had no realtime path at all.
  if (written > 0) await broadcastInboxRefresh('email').catch(() => {})

  return NextResponse.json({ ok: errors.length === 0, account: 'gmail', fetched, written, skipped, errors, durationMs })
}
