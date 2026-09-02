// One-off payment-reminder chase to 8 approved-unpaid vendors that slipped under
// the cron's 7-day gate (first auto-reminder would not fire until ~2026-07-27).
//
// Messaging rule (operator, 2026-07-24): NEVER mention EFT / Yoco / bank details
// / any payment method. Every message says only: log in and pay at the portal.
// (Global EFT mode is ON because Yoco is down; the portal handles the method.)
//
// Records each send into portal_state.payment_reminders.history (same shape the
// cron writes) so the 2026-07-27 cron run does NOT double-remind these 8.
//
// Usage:
//   node --import tsx scripts/_chase-8-eft-reminder.tsx            # DRY RUN (default): render, send nothing
//   ONLY="Joe & Co." SEND=1 node --import tsx scripts/_chase-8-eft-reminder.tsx   # canary: live-send ONE
//   SEND=1 node --import tsx scripts/_chase-8-eft-reminder.tsx     # live-send all 8
// Run with Node 22 (supabase-js realtime breaks on Node 20): use ~/.nvm/versions/node/v22.*/bin/node

import { config } from 'dotenv'
config({ path: '.env.local' })

import { sendTemplate, toE164 } from '../src/lib/whatsapp'
import { sendEmail } from '../src/lib/email/resend'
import { parsePortalState, updatePortalStateImpl } from '../src/lib/portal-state'
import { computeVendorPricing, formatRand } from '../src/lib/payments/pricing'
import { EmailLayout, Heading, Paragraph, Button, Signoff, Divider } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
const PORTAL_URL = 'https://cthalaal.co.za/exhibitor/portal/payments'

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const WANT = [
  'Mias Chill Station', 'Kleinkind Style', 'Joe & Co.', 'Foodhangover',
  'Nilar Rose', 'MAYSABLAY', 'Faya Cotton', 'CN COLLECTION',
].map((s) => s.toLowerCase())

const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 86400000)

// Portal-only WhatsApp body. festival_announcement renders "Hi {{1}}! {{2}}", so
// {{2}} must NOT start with "Hi". No payment method named.
function waBody(amount: number, dueStr: string) {
  return `A friendly reminder that your stall fee of ${formatRand(amount)} for the Young at Heart Festival is due on ${dueStr}. ` +
    `Please log in to your exhibitor portal to view and pay: ${PORTAL_URL}. ` +
    `Your stall is only secured once payment is received in full.`
}

function ReminderEmail(p: { contactName: string; businessName: string; amount: number; dueDate: string; daysRemaining: number }) {
  return (
    <EmailLayout preview={`Stall fee reminder for ${p.businessName}, due ${p.dueDate}`}>
      <Heading>A friendly reminder, your stall is waiting</Heading>
      <Paragraph>Hi {p.contactName},</Paragraph>
      <Paragraph>Quick note: your stall fee is still outstanding. Settle it to lock in your spot.</Paragraph>
      <Divider />
      <Paragraph>
        <strong>Vendor:</strong> {p.businessName}
        <br />
        <strong>Amount due:</strong> {formatRand(p.amount)}
        <br />
        <strong>Due date:</strong> {p.dueDate}
        <br />
        <strong>Status:</strong> {p.daysRemaining} day{p.daysRemaining === 1 ? '' : 's'} remaining
      </Paragraph>
      <Button href={PORTAL_URL}>Log in to pay</Button>
      <Paragraph>
        Log in to your exhibitor portal to view and settle your invoice, then upload your proof of payment there once done.
      </Paragraph>
      <Paragraph>Have a query? Reply to this email and an organiser will help.</Paragraph>
      <Signoff>
        Warm regards,
        <br />
        <strong>The Young at Heart Festival Team</strong>
      </Signoff>
    </EmailLayout>
  )
}

type Row = {
  id: string; business_name: string; contact_name: string | null; email: string | null
  phone: string | null; admin_notes: string | null; reviewed_at: string | null
  preferred_booth_tier: string | null; special_requirements: unknown
}

async function main() {
const today = new Date()
const url = `${BASE}/rest/v1/vendor_applications?status=eq.approved&select=id,business_name,contact_name,email,phone,admin_notes,reviewed_at,preferred_booth_tier,special_requirements`
const all = (await (await fetch(url, { headers: h })).json()) as Row[]
let rows = all.filter((r) => WANT.includes((r.business_name || '').trim().toLowerCase()))
if (ONLY) rows = rows.filter((r) => (r.business_name || '').trim().toLowerCase() === ONLY)

console.log(`\n${DRY ? 'DRY RUN (nothing sent)' : 'LIVE SEND'} — ${rows.length} vendor(s)\n${'='.repeat(60)}`)

let waOk = 0, mailOk = 0, recorded = 0
const fails: string[] = []

for (const r of rows) {
  const st = parsePortalState(r.admin_notes)
  if (st.payment?.status === 'paid' || st.payment?.status === 'waived') { console.log(`SKIP ${r.business_name}: already ${st.payment?.status}`); continue }
  const already = ((st as unknown) as { payment_reminders?: { history?: unknown[] } }).payment_reminders?.history || []
  if (already.length) { console.log(`SKIP ${r.business_name}: already has ${already.length} reminder(s)`); continue }

  const reviewedAt = r.reviewed_at ? new Date(r.reviewed_at) : today
  const due = new Date(reviewedAt); due.setDate(due.getDate() + 30)
  const dueStr = fmtDate(due)
  const daysRemaining = daysBetween(today, due)
  const amount = st.payment?.amount ?? computeVendorPricing({ preferred_booth_tier: r.preferred_booth_tier, special_requirements: r.special_requirements }).total
  const first = (r.contact_name || 'there').trim().split(/\s+/)[0] || 'there'
  const biz = (r.business_name || '').trim()
  const body = waBody(amount, dueStr)

  console.log(`\n### ${biz}  (${first}, ${formatRand(amount)}, due ${dueStr}, ${daysRemaining}d)`)
  console.log(`  WA → ${r.phone}: Hi ${first}! ${body}`)
  console.log(`  EMAIL → ${r.email}: subject "Reminder, your YAH Festival stall fee, ${biz}"`)

  if (DRY) continue

  // WhatsApp
  let sentSomething = false
  try {
    const wr = await sendTemplate(toE164(r.phone || ''), 'festival_announcement', [first, body], { category: 'utility' })
    if (wr.skipped) fails.push(`WA ${biz}: skipped ${wr.skipped}`)
    else { waOk++; sentSomething = true; console.log(`  WA sent`) }
  } catch (e) { fails.push(`WA ${biz}: ${(e as Error).message}`) }

  // Email
  if (r.email) {
    const er = await sendEmail({
      to: r.email,
      subject: `Reminder, your YAH Festival stall fee, ${biz}`,
      react: ReminderEmail({ contactName: r.contact_name || first, businessName: biz, amount, dueDate: dueStr, daysRemaining }),
    })
    if (er.ok) { mailOk++; sentSomething = true; console.log(`  EMAIL sent`) } else fails.push(`EMAIL ${biz}: ${er.error}`)
  } else fails.push(`EMAIL ${biz}: no email`)

  // Record history ONLY if at least one channel actually delivered. A record with
  // no send would make the cron skip a vendor who received nothing (canary caught
  // this on 2026-07-24). No send -> no record, report and move on.
  if (!sentSomething) { fails.push(`RECORD ${biz}: skipped, nothing sent`); continue }

  // Record in portal history (REST PATCH; reuse the canonical pure encoder).
  const nextState = {
    ...st,
    payment_reminders: {
      ...(((st as unknown) as { payment_reminders?: Record<string, unknown> }).payment_reminders || {}),
      history: [{ at: new Date().toISOString(), week: 1 }],
      due_date: due.toISOString(),
    },
  }
  const newNotes = updatePortalStateImpl(r.admin_notes || '', nextState as never)
  const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}`, {
    method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ admin_notes: newNotes }),
  })
  if (pr.ok) { recorded++; console.log(`  history recorded`) } else fails.push(`RECORD ${r.business_name}: ${pr.status} ${await pr.text()}`)

  await new Promise((res) => setTimeout(res, 250)) // Law 5 throttle
}

if (!DRY) {
  console.log(`\n${'='.repeat(60)}\nWA sent: ${waOk} | email sent: ${mailOk} | history recorded: ${recorded}`)
  if (fails.length) { console.log(`\nFAILURES (${fails.length}):`); fails.forEach((f) => console.log(`  - ${f}`)) }
}
}

main().catch((e) => { console.error(e); process.exit(1) })
