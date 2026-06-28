/**
 * Mail fetcher cron — pulls messages from one or more inboxes and lands them as
 * rows in mail_messages, then opens / refreshes a wa_threads row so the unified
 * inbox surfaces the conversation. Runs every 2 minutes via vercel.json.
 * Idempotent on Message-ID.
 *
 * ACCOUNTS (multi-account since 2026-06-28):
 *   - primary  : the support mailbox (GoDaddy). Searches UNSEEN and MARKS SEEN
 *                (it's a system box, so consuming it is fine).
 *   - gmail    : Samreen's capetownhalaal@gmail.com (personal box). Searches
 *                RECENT and NEVER marks seen — we must not touch her read state.
 *                Dedup is on message_id (UNIQUE), so re-seeing the same recent
 *                message is a cheap 23505 skip.
 *
 * If mail_messages does not exist yet the writer surfaces the error but does NOT
 * crash the cron.
 */

import { NextResponse } from 'next/server'
import { ImapFlow, type FetchMessageObject } from 'imapflow'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyCronAuth } from '@/lib/security/cron-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

interface VendorMatch {
  id: string
  contact_name: string | null
  business_name: string | null
}

interface MailAccount {
  label: string
  host: string
  port: number
  user: string
  pass: string
  /** true = consume UNSEEN + mark \Seen (system box). false = read recent
   *  non-destructively, never mark seen (personal box). */
  markSeen: boolean
}

interface AccountReport {
  label: string
  host: string
  fetched: number
  written: number
  skipped: number
  errors: string[]
}

function buildAccounts(): { accounts: MailAccount[]; configErrors: string[] } {
  const accounts: MailAccount[] = []
  const configErrors: string[] = []

  // Primary support mailbox (GoDaddy). IMAP_PASS preferred; SMTP_PASS is the
  // same secret on that stack today (env-hygiene warning kept).
  let primPass = process.env.IMAP_PASS
  if (!primPass && process.env.SMTP_PASS) {
    primPass = process.env.SMTP_PASS
    configErrors.push('config: IMAP_PASS missing, fell back to SMTP_PASS. Set IMAP_PASS in Vercel env.')
  }
  if (primPass) {
    accounts.push({
      label: 'primary',
      host: process.env.IMAP_HOST || 'imap.secureserver.net',
      port: Number(process.env.IMAP_PORT || 993),
      user: process.env.IMAP_USER || 'support@youngatheart.co.za',
      pass: primPass,
      markSeen: true,
    })
  }

  // Samreen's Gmail (added 2026-06-28). NON-destructive: never marks her mail read.
  if (process.env.GMAIL_IMAP_USER && process.env.GMAIL_APP_PASS) {
    accounts.push({
      label: 'gmail',
      host: 'imap.gmail.com',
      port: 993,
      user: process.env.GMAIL_IMAP_USER,
      pass: process.env.GMAIL_APP_PASS,
      markSeen: false,
    })
  }

  return { accounts, configErrors }
}

async function findVendorByEmail(
  supabase: ReturnType<typeof createAdminClient>,
  email: string
): Promise<VendorMatch | null> {
  if (!email) return null
  const { data, error } = await supabase
    .from('vendor_applications')
    .select('id,contact_name,business_name')
    .eq('email', email)
    .limit(1)
  if (error || !data || data.length === 0) return null
  return data[0] as VendorMatch
}

async function fetchAccount(
  acct: MailAccount,
  supabase: ReturnType<typeof createAdminClient>
): Promise<AccountReport> {
  const report: AccountReport = { label: acct.label, host: acct.host, fetched: 0, written: 0, skipped: 0, errors: [] }

  const client = new ImapFlow({
    host: acct.host,
    port: acct.port,
    secure: true,
    auth: { user: acct.user, pass: acct.pass },
    logger: false,
    socketTimeout: 30_000,
  })

  try {
    await client.connect()
  } catch (e) {
    const msg = (e as Error).message
    console.error(JSON.stringify({ at: 'mail-fetcher', account: acct.label, event: 'connect_failed', host: acct.host, error: msg }))
    try { await client.close() } catch { /* swallow */ }
    report.errors.push(`imap connect (${acct.label}): ${msg}`)
    return report
  }

  let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | null = null
  try {
    lock = await client.getMailboxLock('INBOX')
    // Personal box: read RECENT (last 2 days) non-destructively. System box:
    // consume UNSEEN. Dedup on message_id makes re-seeing recent mail cheap.
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const criteria = acct.markSeen ? { seen: false } : { since }
    const uidsRaw = await client.search(criteria, { uid: true })
    const uids: number[] = Array.isArray(uidsRaw) ? uidsRaw : []
    const toFetch = uids.slice(-50) // newest 50

    for (const uid of toFetch) {
      report.fetched += 1
      let msg: FetchMessageObject | null = null
      try {
        msg = (await client.fetchOne(String(uid), {
          envelope: true,
          source: true,
          headers: ['message-id', 'auto-submitted', 'x-auto-response-suppress', 'precedence', 'list-unsubscribe', 'in-reply-to', 'references'],
        }, { uid: true })) as FetchMessageObject
      } catch (e) {
        report.errors.push(`uid ${uid} fetch: ${(e as Error).message}`)
        report.skipped += 1
        continue
      }
      if (!msg) { report.skipped += 1; continue }

      const headerBlob = msg.headers ? msg.headers.toString('utf8') : ''
      const autoSubmittedMatch = headerBlob.match(/^auto-submitted:\s*([^\r\n]+)/im)
      const autoSubmitted = autoSubmittedMatch !== null && autoSubmittedMatch[1].trim().toLowerCase() !== 'no'
      const autoSuppress = /^x-auto-response-suppress:\s*\S/im.test(headerBlob)
      const precedence = /^precedence:\s*(bulk|list|junk)/im.test(headerBlob)
      if (autoSubmitted || autoSuppress || precedence) {
        if (acct.markSeen) {
          try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) } catch { /* swallow */ }
        }
        report.skipped += 1
        continue
      }

      const messageIdMatch = headerBlob.match(/^message-id:\s*(.+)$/im)
      const messageId = (messageIdMatch?.[1] || msg.envelope?.messageId || '').trim()
      if (!messageId) { report.skipped += 1; continue }

      const fromRaw = msg.envelope?.from?.[0]
      const fromAddress = (fromRaw?.address || '').toLowerCase()
      const fromName = fromRaw?.name || null
      const toAddress = (msg.envelope?.to?.[0]?.address || acct.user).toLowerCase()
      const subject = msg.envelope?.subject || ''
      const receivedAt = (msg.envelope?.date || new Date()).toISOString()
      const body = msg.source instanceof Buffer ? msg.source.toString('utf8').slice(0, 8000) : ''

      const vendor = await findVendorByEmail(supabase, fromAddress)

      let threadId: string | null = null
      try {
        const { data: tid, error: rpcErr } = await supabase.rpc('upsert_thread', {
          p_channel: 'mail',
          p_key: fromAddress,
          p_inbound_at: receivedAt,
        })
        if (rpcErr) throw rpcErr
        threadId = (tid as string) ?? null
      } catch (e) {
        report.errors.push(`thread upsert ${fromAddress}: ${(e as Error).message}`)
        continue
      }

      try {
        const { error: insErr } = await supabase.from('mail_messages').insert({
          thread_id: threadId,
          message_id: messageId,
          from_address: fromAddress,
          from_name: fromName,
          to_address: toAddress,
          subject,
          body,
          direction: 'inbound',
          vendor_application_id: vendor?.id ?? null,
          received_at: receivedAt,
        })
        if (insErr) {
          const code = (insErr as { code?: string }).code
          if (code !== '23505') { report.errors.push(`insert ${messageId}: ${insErr.message}`); continue }
          // 23505 = already imported (idempotent). Fine.
        } else {
          report.written += 1
        }
      } catch (e) {
        report.errors.push(`insert ${messageId}: ${(e as Error).message}`)
        continue
      }

      // Mark seen ONLY for the system box, and only after the row is durable.
      if (acct.markSeen) {
        try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) } catch (e) { report.errors.push(`flag seen ${uid}: ${(e as Error).message}`) }
      }
    }
  } catch (e) {
    report.errors.push(`loop (${acct.label}): ${(e as Error).message}`)
    console.error(JSON.stringify({ at: 'mail-fetcher', account: acct.label, event: 'loop_error', error: (e as Error).message }))
  } finally {
    if (lock) { try { lock.release() } catch { /* swallow */ } }
    await client.logout().catch(async () => { try { await client.close() } catch { /* swallow */ } })
  }

  return report
}

interface FetcherReport {
  ok: boolean
  fetched: number
  written: number
  skipped: number
  errors: string[]
  accounts: AccountReport[]
  durationMs: number
}

export async function GET(req: Request): Promise<NextResponse<FetcherReport>> {
  const started = Date.now()

  if (!verifyCronAuth(req.headers.get('authorization'))) {
    console.warn(JSON.stringify({ at: 'mail-fetcher', event: 'unauthorized' }))
    return NextResponse.json(
      { ok: false, fetched: 0, written: 0, skipped: 0, errors: ['unauthorized'], accounts: [], durationMs: 0 },
      { status: 401 }
    )
  }

  const { accounts, configErrors } = buildAccounts()
  if (accounts.length === 0) {
    return NextResponse.json(
      { ok: false, fetched: 0, written: 0, skipped: 0, errors: ['no mail account configured', ...configErrors], accounts: [], durationMs: Date.now() - started },
      { status: 500 }
    )
  }

  const supabase = createAdminClient()
  const reports: AccountReport[] = []
  // Sequential: keep memory + concurrent IMAP connections bounded.
  for (const acct of accounts) {
    reports.push(await fetchAccount(acct, supabase))
  }

  const fetched = reports.reduce((s, r) => s + r.fetched, 0)
  const written = reports.reduce((s, r) => s + r.written, 0)
  const skipped = reports.reduce((s, r) => s + r.skipped, 0)
  const errors = [...configErrors, ...reports.flatMap((r) => r.errors)]
  const durationMs = Date.now() - started

  console.log(JSON.stringify({ at: 'mail-fetcher', event: 'run_complete', accounts: reports.map((r) => ({ label: r.label, fetched: r.fetched, written: r.written, skipped: r.skipped, errs: r.errors.length })), durationMs }))

  return NextResponse.json({ ok: errors.length === 0, fetched, written, skipped, errors, accounts: reports, durationMs })
}
