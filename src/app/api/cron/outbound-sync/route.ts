// Outbound message sync cron.
//
// Fires every 5 minutes. Its job is to make sure ANY email sent through Resend
// ends up in the admin inbox, even if the original send path forgot to mirror it
// (terminal scripts, older cron jobs, manual API calls). WhatsApp sends are
// logged at source by the shared send functions; this cron does not try to poll
// Meta for them.
//
// Vercel cron config (add to vercel.json):
//   { "path": "/api/cron/outbound-sync", "schedule": "*/5 * * * *" }

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { logEmailOutbound } from '@/lib/outbound-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim()

interface ResendEmail {
  id: string
  from: string
  to: string[] | string
  subject: string | null
  text?: string | null
  html?: string | null
  created_at: string
}

/**
 * THE FESTIVAL SENDER WALL (2026-08-01). This Resend account is shared with
 * other apps (ad-platform alerts, account-health warnings). The first version
 * of this sync imported EVERYTHING the account sent, and Louis's AdPilot /
 * account-health emails landed in the festival inbox as outbound threads.
 * Only festival sends belong here. Fail CLOSED: a missing/unparseable `from`
 * is not imported.
 */
export function isFestivalSender(from: string | null | undefined): boolean {
  // Exact address match: take the <...> form's inner address when present.
  // `includes` would let support@youngatheart.co.za.evil.com through.
  const raw = (from || '').toLowerCase().trim()
  const addr = (raw.match(/<([^>]+)>/)?.[1] || raw).trim()
  return addr === 'support@youngatheart.co.za'
}

async function listResendEmails(since: string): Promise<ResendEmail[]> {
  if (!RESEND_API_KEY) return []
  const url = new URL('https://api.resend.com/emails')
  url.searchParams.set('created_after', since)
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Resend list failed ${res.status}: ${body}`)
  }
  const json = (await res.json().catch(() => ({}))) as { data?: ResendEmail[] }
  return json.data || []
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  if (!RESEND_API_KEY) {
    return NextResponse.json({ ok: false, error: 'RESEND_API_KEY missing' }, { status: 503 })
  }

  // Look back 15 minutes to cover any cron drift or missed runs.
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
  try {
    const emails = await listResendEmails(since)
    let imported = 0
    let skippedForeign = 0
    for (const e of emails) {
      // Festival sends only — the account is shared with other apps.
      if (!isFestivalSender(e.from)) { skippedForeign++; continue }
      const to = Array.isArray(e.to) ? e.to[0] : e.to
      if (!to) continue
      const ok = await logEmailOutbound({
        to,
        subject: e.subject || '(no subject)',
        text: e.text || null,
        html: e.html || null,
        providerMessageId: e.id,
      })
      if (ok) imported++
    }
    return NextResponse.json({ ok: true, checked: emails.length, imported, skippedForeign })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[outbound-sync] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }
}
