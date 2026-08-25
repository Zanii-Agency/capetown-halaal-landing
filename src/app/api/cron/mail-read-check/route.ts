// Read-only diagnostic: reports whether specific senders' emails have been READ
// (IMAP \Seen) in capetownhalaal@gmail.com. Answers "of the emails that leaked
// EFT content into her inbox, how many has she actually opened."
//
// SAFETY: opens the mailbox in EXAMINE (readOnly) mode, so the server physically
// cannot set \Seen — this can never mark her mail read. Fetches flags + envelope
// only, never message bodies. Cron-gated (Authorization: Bearer CRON_SECRET), so
// it is not publicly reachable. The GMAIL_APP_PASS is a Vercel Sensitive var, so
// this can only run server-side; it exists because the value cannot be pulled
// locally. The live fetcher never marks mail read, so \Seen is a clean signal of
// what SHE opened, not what a cron touched.

import { NextRequest, NextResponse } from 'next/server'
import { ImapFlow } from 'imapflow'
import { verifyCronAuth } from '@/lib/security/cron-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const DEFAULT_FROM = [
  'frostedcravings.za@gmail.com',
  'nazlee.jacobs@islamic-relief.org.za',
  'ysumsodien786@gmail.com',
  'sgoolam@yahoo.com',
  'info@primalwellness.co.za',
]

type Row = { date: string | null; subject: string | null; seen: boolean }

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const user = process.env.GMAIL_IMAP_USER || 'capetownhalaal@gmail.com'
  const pass = process.env.GMAIL_APP_PASS
  if (!pass) {
    return NextResponse.json({ ok: false, error: 'GMAIL_APP_PASS not set' }, { status: 503 })
  }

  const fromParam = (new URL(req.url).searchParams.get('from') || '').trim()
  const senders = fromParam ? fromParam.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_FROM

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass }, logger: false, socketTimeout: 30_000,
  })
  const out: Record<string, Row[]> = {}
  try {
    await client.connect()
    try {
      await client.mailboxOpen('[Gmail]/All Mail', { readOnly: true })
    } catch {
      await client.mailboxOpen('INBOX', { readOnly: true })
    }
    for (const sender of senders) {
      const uids = (await client.search({ from: sender }, { uid: true })) || []
      const recent = uids.slice(-10)
      const rows: Row[] = []
      if (recent.length) {
        for await (const m of client.fetch(recent, { uid: true, flags: true, envelope: true }, { uid: true })) {
          rows.push({
            date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
            subject: m.envelope?.subject ?? null,
            seen: !!(m.flags && m.flags.has('\\Seen')),
          })
        }
      }
      out[sender] = rows
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  } finally {
    try { await client.logout() } catch { /* ignore */ }
  }

  const flat = Object.values(out).flat()
  const summary = { total: flat.length, read: flat.filter((r) => r.seen).length, unread: flat.filter((r) => !r.seen).length }
  return NextResponse.json({ ok: true, mailbox: user, summary, senders: out })
}
