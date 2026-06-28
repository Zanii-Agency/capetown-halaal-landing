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
import { verifyCronAuth } from '@/lib/security/cron-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

async function findVendorByEmail(
  supabase: ReturnType<typeof createAdminClient>,
  email: string
): Promise<{ id: string } | null> {
  if (!email) return null
  const { data } = await supabase.from('vendor_applications').select('id').eq('email', email).limit(1)
  return (data?.[0] as { id: string }) || null
}

export async function GET(req: Request) {
  const started = Date.now()
  const errors: string[] = []
  let fetched = 0, written = 0, skipped = 0

  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ ok: false, errors: ['unauthorized'], durationMs: 0 }, { status: 401 })
  }

  const user = process.env.GMAIL_IMAP_USER
  const pass = process.env.GMAIL_APP_PASS
  if (!user || !pass) {
    return NextResponse.json({ ok: true, skipped: 'GMAIL_IMAP_USER/GMAIL_APP_PASS not set', durationMs: Date.now() - started })
  }

  const supabase = createAdminClient()
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false, socketTimeout: 30_000 })

  try {
    await client.connect()
  } catch (e) {
    try { await client.close() } catch { /* swallow */ }
    return NextResponse.json({ ok: false, errors: [`imap connect: ${(e as Error).message}`], durationMs: Date.now() - started }, { status: 502 })
  }

  let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | null = null
  try {
    lock = await client.getMailboxLock('INBOX')
    // NON-DESTRUCTIVE: read RECENT (last 3 days), never mark seen. Dedup via the
    // message-existence check below so re-reads are cheap no-ops.
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const uidsRaw = await client.search({ since }, { uid: true })
    const uids: number[] = Array.isArray(uidsRaw) ? uidsRaw : []
    const toFetch = uids.slice(-50)

    for (const uid of toFetch) {
      fetched += 1
      let msg: FetchMessageObject | null = null
      try {
        msg = (await client.fetchOne(String(uid), {
          envelope: true, source: true,
          headers: ['message-id', 'auto-submitted', 'x-auto-response-suppress', 'precedence', 'in-reply-to'],
        }, { uid: true })) as FetchMessageObject
      } catch (e) { errors.push(`uid ${uid} fetch: ${(e as Error).message}`); skipped += 1; continue }
      if (!msg) { skipped += 1; continue }

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
          in_reply_to: inReplyTo, provider: 'gmail', received_at: receivedAt,
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
  return NextResponse.json({ ok: errors.length === 0, account: 'gmail', fetched, written, skipped, errors, durationMs })
}
