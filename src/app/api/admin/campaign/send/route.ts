import { NextRequest, NextResponse } from 'next/server'
import { render } from '@react-email/components'
import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/admin'
import { Campaign, type CampaignProps } from '@/lib/email/templates/Campaign'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { requireOperator } from '@/lib/admin-rbac'

export const maxDuration = 300

const FROM = 'Young at Heart Festival <support@youngatheart.co.za>'
const FREE_DAILY_CAP = 100 // Resend free tier = 100/day. Guard against silent overflow.
const PACE_MS = 300 // ~3.3 sends/sec, comfortably under Resend's 10/sec Pro rate limit. Keeps batches under Vercel's per-request window.

type Audience = 'vendors' | 'vendors_pending' | 'vendors_approved' | 'buyers' | 'test'

/* ----- auth: Bearer CRON_SECRET (terminal) OR admin session (portal) ----- */
async function authorize(request: NextRequest): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  // Cron branch (CRON_SECRET bearer) left untouched: machine-to-machine sends.
  if (verifyCronAuth(request.headers.get('authorization'))) return { ok: true }

  // Admin branch: this SENDS bulk email, so it must be role-gated (owner/operator),
  // not membership-only. Centralised through requireOperator.
  const gate = await requireOperator()
  if (!gate.ok) return { ok: false, res: gate.response }
  return { ok: true }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const firstName = (n?: string | null) => {
  const f = (n || '').trim().split(/\s+/)[0]
  return f ? f.charAt(0).toUpperCase() + f.slice(1) : 'there'
}

type Recipient = { email: string; name: string; id?: string; notes?: string }

async function getRecipients(audience: Audience, testTo: string[]): Promise<Recipient[]> {
  const admin = createAdminClient()
  if (audience === 'test') return testTo.map((e) => ({ email: e, name: 'there' }))

  if (audience === 'buyers') {
    const { data } = await admin.from('ticket_buyers').select('email, name')
    return (data || []).map((r) => ({ email: r.email, name: firstName(r.name) }))
  }

  // Vendor audiences carry id + admin_notes so a campaign can durably mark who it reached.
  let q = admin.from('vendor_applications').select('id, email, contact_name, admin_notes').order('email', { ascending: true })
  if (audience === 'vendors_pending') q = q.in('status', ['pending', 'info_requested'])
  else if (audience === 'vendors_approved') q = q.eq('status', 'approved')
  const { data } = await q
  return (data || []).map((r) => ({ id: r.id, email: r.email, name: firstName(r.contact_name), notes: r.admin_notes || '' }))
}

/** Dedupe by lowercased email, drop invalids. */
function clean(list: Recipient[]) {
  const seen = new Set<string>()
  const out: Recipient[] = []
  for (const r of list) {
    const e = (r.email || '').trim().toLowerCase()
    if (!EMAIL_RE.test(e) || seen.has(e)) continue
    seen.add(e)
    out.push({ ...r, email: e })
  }
  return out
}

const personalize = (s: string | undefined, name: string) => (s ? s.replace(/\{name\}/g, name) : s)

export async function POST(request: NextRequest) {
  const auth = await authorize(request)
  if (!auth.ok) return auth.res

  let body: {
    audience: Audience
    subject: string
    content: Omit<CampaignProps, 'unsubscribeUrl'>
    testTo?: string[]
    dryRun?: boolean
    limit?: number
    offset?: number
    excludeEmails?: string[]
    markNote?: string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { audience, subject, content, testTo = [], dryRun = false } = body
  if (!audience || !subject || !content?.heading) {
    return NextResponse.json({ error: 'audience, subject and content.heading are required' }, { status: 400 })
  }

  // Durable dedup: a markNote stamps admin_notes on send, so re-runs skip anyone already reached.
  // This is the source of truth (immune to local-file/ledger drift). excludeEmails remains as a belt-and-braces extra.
  const markNote = (body.markNote || '').trim()
  const exclude = new Set((body.excludeEmails || []).map((e) => (e || '').trim().toLowerCase()))
  const allRecipients = clean(await getRecipients(audience, testTo))
  const recipients = allRecipients.filter(
    (r) =>
      !exclude.has(r.email) &&
      !(markNote && (r.notes || '').toLowerCase().includes(markNote.toLowerCase()))
  )
  const total = recipients.length
  const excluded = allRecipients.length - total

  // Resumable batching: offset slices into the deterministic ordered cohort so multi-call sends are non-overlapping.
  const offset = Math.max(0, Math.floor(body.offset ?? 0))
  const remainingFromOffset = Math.max(0, total - offset)
  const cap = body.limit ?? FREE_DAILY_CAP
  const willSend = Math.min(remainingFromOffset, cap)
  const skippedOverCap = remainingFromOffset - willSend
  const nextOffset = offset + willSend
  const capWarning =
    skippedOverCap > 0
      ? `Recipient list (${remainingFromOffset} remaining from offset ${offset}) exceeds the send cap (${cap}). Only ${willSend} will be sent this call. Re-run with offset=${nextOffset} for the rest.`
      : null

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      audience,
      subject,
      total,
      excluded,
      offset,
      willSend,
      nextOffset,
      remainingFromOffset,
      skippedOverCap,
      capWarning,
      sample: recipients.slice(offset, offset + 5).map((r) => r.email),
    })
  }

  const apiKey = (process.env.RESEND_API_KEY || '').trim()
  if (!apiKey) return NextResponse.json({ error: 'RESEND_API_KEY missing' }, { status: 500 })
  const resend = new Resend(apiKey)

  // Personalisation: if no {name} token anywhere, render once and reuse (fast for bulk).
  const fields = [content.heading, content.greeting, content.signoff, content.bodyHtml, ...(content.paragraphs || [])]
  const personalised = fields.some((f) => typeof f === 'string' && f.includes('{name}'))
  const unsubscribeUrl = 'mailto:support@youngatheart.co.za?subject=unsubscribe'

  let cachedHtml: string | null = null
  async function renderFor(name: string): Promise<string> {
    if (!personalised) {
      if (!cachedHtml) cachedHtml = await render(Campaign({ ...content, unsubscribeUrl }))
      return cachedHtml
    }
    return render(
      Campaign({
        ...content,
        heading: personalize(content.heading, name)!,
        greeting: personalize(content.greeting, name),
        signoff: personalize(content.signoff, name),
        bodyHtml: personalize(content.bodyHtml, name),
        paragraphs: content.paragraphs?.map((p) => personalize(p, name)!),
        unsubscribeUrl,
      })
    )
  }

  let sent = 0
  let failed = 0
  const errors: { email: string; error: string }[] = []
  const slice = recipients.slice(offset, offset + willSend)

  const admin = markNote ? createAdminClient() : null
  const today = new Date().toISOString().slice(0, 10)
  const markLine = `${today}: ${markNote}`

  for (const r of slice) {
    try {
      const html = await renderFor(r.name)
      const { error } = await resend.emails.send({
        from: FROM,
        to: r.email,
        replyTo: 'support@youngatheart.co.za',
        subject,
        html,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` },
      })
      if (error) throw new Error(error.message)
      sent++
      // Stamp the durable marker only after a confirmed send, so dedup never claims an unsent vendor.
      if (admin && r.id) {
        const newNotes = (r.notes || '').trim() ? `${r.notes}\n${markLine}` : markLine
        const { error: stampError } = await admin.from('vendor_applications').update({ admin_notes: newNotes }).eq('id', r.id)
        if (stampError) {
          console.error('[campaign/send] dedup marker stamp failed for', r.id, stampError.message)
        }
      }
    } catch (e) {
      failed++
      errors.push({ email: r.email, error: (e as Error).message })
    }
    if (PACE_MS) await new Promise((res) => setTimeout(res, PACE_MS))
  }

  return NextResponse.json({
    audience,
    subject,
    total,
    excluded,
    offset,
    sent,
    failed,
    nextOffset,
    remainingFromOffset,
    skippedOverCap,
    capWarning,
    errors: errors.slice(0, 25),
  })
}
