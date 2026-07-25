// Operator-approved CUSTOM payment chase, run one batch at a time (2026-07-25).
// The machinery lives here; the hand-written copy lives in scripts/chase-copy/
// batch-N.json so each new batch is a data file, not a copy of this script.
//
// WhatsApp + email, records payment_reminders.history so the cron will not
// double-fire. Merged duplicate rows (same business_name) get one WA per
// distinct phone, one email per distinct address, history to every row.
// No payment method named (operator rule 2026-07-24). No em-dashes (Law 7).
//
// festival_announcement renders "Hi {{1}}! {{2}}", so each `wa` body starts
// AFTER the greeting (no leading "Hi <name>").
//
//   COPY=scripts/chase-copy/batch-2.json node --env-file=.env.local --import tsx scripts/chase-batch.tsx
//   ONLY="kgotsos pride" SEND=1 COPY=... node --env-file=.env.local --import tsx scripts/chase-batch.tsx
//   SEND=1 COPY=... node --env-file=.env.local --import tsx scripts/chase-batch.tsx
// Run with Node 22+.
//
// NOTE: --env-file is MANDATORY for a live send. src/lib/whatsapp.ts and
// src/lib/email/resend.ts read their tokens into module-level consts at import
// time, and ESM hoists those imports above any in-script config(), so dotenv
// alone leaves both libs unconfigured. The dotenv call below only populates
// process.env for the REST fetches; the abort guard below catches the rest.
import fs from 'node:fs'
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sendTemplate, toE164, whatsappConfigured } from '../src/lib/whatsapp'
import { sendEmail } from '../src/lib/email/resend'
import { parsePortalState, updatePortalStateImpl } from '../src/lib/portal-state'
import { computeVendorPricing, formatRand } from '../src/lib/payments/pricing'
import { EmailLayout, Heading, Paragraph, Button, Signoff, Divider } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
// Comma-separated keys already sent (e.g. the canary), so the follow-up run of
// the same batch does not double-message them.
const SKIP = new Set((process.env.SKIP || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
const COPY = process.env.COPY || 'scripts/chase-copy/batch-1.json'
const PORTAL = 'https://cthalaal.co.za/exhibitor/portal/payments'

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 86400000)
const e164 = (p?: string | null) => { try { return p ? toE164(p) : '' } catch { return '' } }

// `days` is the overdue count baked into the hand-written copy. The script
// recomputes it from the DB and refuses to send if they disagree, so copy that
// went stale overnight never reaches a vendor. `noWa` skips WhatsApp for a
// vendor whose stored number is unusable (sending to a malformed E.164 could
// deliver payment details to a stranger, Law 2).
type Custom = {
  key: string; first: string; days: number; noWa?: boolean
  wa: string; subject: string; heading: string; lead: string
}

const BATCH: Custom[] = JSON.parse(fs.readFileSync(COPY, 'utf8'))

// Payment states that mean "do not chase". See the live filter below.
const SETTLED = new Set(['paid', 'waived', 'collected', 'deferred'])

type Row = {
  id: string; business_name: string | null; contact_name: string | null; email: string | null
  phone: string | null; admin_notes: string | null; reviewed_at: string | null; created_at: string | null
  preferred_booth_tier: string | null; special_requirements: unknown
}

type Resolved = {
  c: Custom; rows: Row[]; primary: Row; amount: number; due: Date; overdueDays: number
  phones: string[]; emails: string[]
}

function CustomEmail(p: { c: Custom; amount: number; dueStr: string; overdueDays: number }) {
  return (
    <EmailLayout preview={p.c.subject}>
      <Heading>{p.c.heading}</Heading>
      <Paragraph>Hi {p.c.first},</Paragraph>
      <Paragraph>{p.c.lead}</Paragraph>
      <Divider />
      <Paragraph>
        <strong>Amount due:</strong> {formatRand(p.amount)}
        <br />
        <strong>Due date:</strong> {p.dueStr}
        <br />
        <strong>Status:</strong> {p.overdueDays} day{p.overdueDays === 1 ? '' : 's'} overdue
      </Paragraph>
      <Button href={PORTAL}>Log in to pay</Button>
      <Paragraph>Log in to your exhibitor portal to view and settle your invoice, then upload your proof of payment there once done.</Paragraph>
      <Paragraph>Have a query? Reply to this email and an organiser will help.</Paragraph>
      <Signoff>
        Warm regards,
        <br />
        <strong>The Young at Heart Festival Team</strong>
      </Signoff>
    </EmailLayout>
  )
}

async function main() {
  const today = new Date()
  const url = `${BASE}/rest/v1/vendor_applications?status=eq.approved&select=id,business_name,contact_name,email,phone,admin_notes,reviewed_at,created_at,preferred_booth_tier,special_requirements`
  const all = (await (await fetch(url, { headers: h })).json()) as Row[]

  console.log(`\n${DRY ? 'DRY RUN (nothing sent)' : 'LIVE SEND'} — ${COPY} (${BATCH.length} vendor${BATCH.length === 1 ? '' : 's'})`)
  console.log(`config: whatsapp=${whatsappConfigured} resend=${!!(process.env.RESEND_API_KEY || '').trim()}`)
  if (!DRY && (!whatsappConfigured || !(process.env.RESEND_API_KEY || '').trim())) {
    console.log('ABORT: a channel is not configured. Run with: node --env-file=.env.local --import tsx scripts/chase-batch.tsx')
    return
  }
  console.log('='.repeat(66))

  // Pass 1: resolve + validate EVERY vendor before anything is sent.
  const resolved: Resolved[] = []
  const problems: string[] = []
  for (const c of BATCH) {
    if (ONLY && c.key !== ONLY) continue
    if (SKIP.has(c.key)) { console.log(`SKIP ${c.key}: already sent this batch`); continue }
    const rows = all.filter((r) => (r.business_name || '').trim().toLowerCase() === c.key)
    if (!rows.length) { problems.push(`NO ROW for "${c.key}"`); continue }
    // Guard: never chase a vendor who has since paid. 'collected' counts as paid:
    // an operator confirmed the money landed and the vendor already sees PAID and
    // was acknowledged (src/lib/portal-state.ts:73); paid_at stays null only so
    // finance does not double-count before Yoco settles. 'deferred' is an agreed
    // postponement. Chasing either bills someone we already told was settled.
    const live = rows.filter((r) => { const s = parsePortalState(r.admin_notes).payment?.status || ''; return !(r as unknown as { paid_at?: string }).paid_at && !SETTLED.has(s) })
    if (!live.length) { console.log(`SKIP ${c.key}: now paid/waived`); continue }

    // Primary = MOST-overdue row (earliest reviewed_at => earliest due), so a
    // merged vendor is framed on its oldest obligation, not an arbitrary
    // PostgREST row order.
    live.sort((a, b) => new Date(a.reviewed_at || a.created_at || 0).getTime() - new Date(b.reviewed_at || b.created_at || 0).getTime())
    const primary = live[0]
    const st0 = parsePortalState(primary.admin_notes)
    const base = primary.reviewed_at ? new Date(primary.reviewed_at) : (primary.created_at ? new Date(primary.created_at) : today)
    const due = new Date(base); due.setDate(due.getDate() + 30)
    const overdueDays = Math.abs(daysBetween(today, due))
    const amount = st0.payment?.amount ?? computeVendorPricing({ preferred_booth_tier: primary.preferred_booth_tier, special_requirements: primary.special_requirements }).total
    const phones = c.noWa ? [] : [...new Set(live.map((r) => e164(r.phone)).filter(Boolean))]
    const emails = [...new Set(live.map((r) => (r.email || '').trim()).filter(Boolean))]

    // The copy hardcodes the overdue count. If the DB disagrees the copy is
    // stale (approval slipped past midnight, or a due date moved).
    if (c.days !== overdueDays) problems.push(`STALE COPY ${c.key}: copy says ${c.days}d overdue, DB says ${overdueDays}d (due ${fmtDate(due)})`)
    if (!emails.length) problems.push(`NO EMAIL for ${c.key}`)
    if (!phones.length && !c.noWa) problems.push(`NO PHONE for ${c.key}`)

    resolved.push({ c, rows: live, primary, amount, due, overdueDays, phones, emails })
    console.log(`\n### ${primary.business_name}  (${c.first}, ${formatRand(amount)}, due ${fmtDate(due)}, ${overdueDays}d overdue${live.length > 1 ? `, ${live.length} rows` : ''})`)
    console.log(`  WA → ${c.noWa ? '(skipped, unusable number on file)' : phones.join(', ')}${c.noWa ? '' : `: Hi ${c.first}! ${c.wa}`}`)
    console.log(`  EMAIL → ${emails.join(', ')}: "${c.subject}"`)
  }

  if (problems.length) {
    console.log(`\n${'='.repeat(66)}\nABORT, ${problems.length} problem(s), nothing sent:`)
    problems.forEach((p) => console.log(`  - ${p}`))
    process.exitCode = 1
    return
  }
  console.log(`\n${'='.repeat(66)}\nvalidated ${resolved.length} vendor(s): copy day-counts match the DB`)
  if (DRY) return

  // Pass 2: send.
  let waOk = 0, mailOk = 0, recorded = 0
  const fails: string[] = []
  for (const t of resolved) {
    const { c } = t
    let sent = false
    for (const phone of t.phones) {
      try {
        const wr = await sendTemplate(phone, 'festival_announcement', [c.first, c.wa], { category: 'utility' })
        if (wr.skipped) fails.push(`WA ${c.key} (${phone}): skipped ${wr.skipped}`)
        else { waOk++; sent = true; console.log(`  WA sent → ${phone} (${c.key})`) }
      } catch (e) { fails.push(`WA ${c.key} (${phone}): ${(e as Error).message}`) }
    }
    for (const email of t.emails) {
      try {
        const er = await sendEmail({ to: email, subject: c.subject, react: CustomEmail({ c, amount: t.amount, dueStr: fmtDate(t.due), overdueDays: t.overdueDays }) })
        if (er.ok) { mailOk++; sent = true; console.log(`  EMAIL sent → ${email} (${c.key})`) } else fails.push(`EMAIL ${c.key} (${email}): ${er.error}`)
      } catch (e) { fails.push(`EMAIL ${c.key} (${email}): ${(e as Error).message}`) }
    }
    // History ONLY if a channel actually delivered (canary lesson 2026-07-24: a
    // record with no send makes the cron skip a vendor who got nothing).
    if (!sent) { fails.push(`RECORD ${c.key}: nothing sent`); continue }

    for (const r of t.rows) {
      const st = parsePortalState(r.admin_notes)
      const prior = ((st as unknown) as { payment_reminders?: { history?: { at: string; week: number }[] } }).payment_reminders?.history || []
      const nextState = { ...st, payment_reminders: { ...(((st as unknown) as { payment_reminders?: Record<string, unknown> }).payment_reminders || {}), history: [...prior, { at: new Date().toISOString(), week: Math.min(prior.length + 1, 4) }], due_date: t.due.toISOString() } }
      const newNotes = updatePortalStateImpl(r.admin_notes || '', nextState as never)
      const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}`, { method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ admin_notes: newNotes }) })
      if (pr.ok) recorded++; else fails.push(`RECORD ${c.key} (${r.id}): ${pr.status} ${await pr.text()}`)
    }
    console.log(`  history recorded (${t.rows.length} row${t.rows.length === 1 ? '' : 's'})`)
    await new Promise((res) => setTimeout(res, 250)) // Law 5 throttle
  }

  console.log(`\n${'='.repeat(66)}`)
  console.log(`WA sent: ${waOk} | email sent: ${mailOk} | history rows recorded: ${recorded}`)
  if (fails.length) { console.log(`\nFAILURES (${fails.length}):`); fails.forEach((f) => console.log(`  - ${f}`)) }
  else console.log('no failures')
}

main().catch((e) => { console.error(e); process.exit(1) })
