// Deliberate SECOND touch on vendors whose stall fee is already overdue.
// 2026-07-29, authorised by Taona: "Send to both chanelles but also dont offer
// that they ned mor etim, drive people to pay just remind them" + "Do both".
//
// WHY THIS IS NOT THE USUAL CHASE, AND WHY IT ONLY TARGETS THE OVERDUE
//
// The Monday cron (/api/cron/payment-reminders, 0 7 * * 1) already runs with a
// 7-day gate. Measured today: of the 53 vendors due or overdue, 52 were
// reminded 2 to 3 days ago and several are on their third reminder. A blanket
// re-send would nag 21 vendors whose deadline has not even arrived.
//
// So this targets ONLY vendors already past their due date. That is a defensible
// second contact, and it is deliberate: unlike the cron and unlike
// _chase-8-eft-reminder.tsx, this script does NOT skip a vendor who already has
// reminder history. It does still record into payment_reminders.history so
// Monday's cron sees the contact and does not stack a third message on top.
//
// NO PAYMENT METHOD IS NAMED. Global EFT mode is ON and 47 of the 53 in this
// cohort are on the EFT lane, so "pay by card" would be wrong for most of them
// and naming EFT would put the arrangement into a message that gets logged where
// the festival owner reads. The portal already shows each vendor the right
// method. Every message says only: log in and pay.
//
// NO OFFER OF MORE TIME, per the instruction above. A support line stays, since
// a vendor with a genuine problem still needs a way through, but nothing in the
// copy invites an extension.
//
// Usage:
//   node --import tsx scripts/_chase-overdue-2026-07-29.tsx                 # DRY RUN, sends nothing
//   ONLY="Telkom" SEND=1 node --import tsx scripts/_chase-overdue-2026-07-29.tsx   # canary, one vendor
//   SEND=1 node --import tsx scripts/_chase-overdue-2026-07-29.tsx          # live send

import { config } from 'dotenv'
config({ path: '.env.local' })

import { sendTemplate, toE164 } from '../src/lib/whatsapp'
import { sendEmail } from '../src/lib/email/resend'
import { parsePortalState, updatePortalStateImpl, hasPaid, isChaseSuppressed } from '../src/lib/portal-state'
import { computeVendorPricing, formatRand } from '../src/lib/payments/pricing'
import { computePaymentDue, daysUntil, fmtDate } from '../src/lib/exhibitor-paygate'
import { EmailLayout, Heading, Paragraph, Button, Signoff, Divider } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
const PORTAL_URL = 'https://cthalaal.co.za/exhibitor/portal/payments'

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

// festival_announcement renders "Hi {{1}}! {{2}}", so {{2}} must NOT start with
// a greeting. Law 7: commas and periods, never a long dash.
function waBody(amount: number, dueStr: string, daysOver: number) {
  return `Your stall fee of ${formatRand(amount)} for the Young at Heart Festival was due on ${dueStr}, ` +
    `so it is now ${daysOver} day${daysOver === 1 ? '' : 's'} overdue. ` +
    `Please log in to your exhibitor portal and complete your payment today: ${PORTAL_URL}. ` +
    `Your stall is only secured once payment is received in full.`
}

function OverdueEmail(p: { contactName: string; businessName: string; amount: number; dueDate: string; daysOver: number }) {
  return (
    <EmailLayout preview={`Your stall fee is ${p.daysOver} days overdue, ${p.businessName}`}>
      <Heading>Your stall fee is overdue</Heading>
      <Paragraph>Hi {p.contactName},</Paragraph>
      <Paragraph>
        Your stall fee for the Young at Heart Festival has passed its due date. Please settle it today so your
        place at the festival is secured.
      </Paragraph>
      <Divider />
      <Paragraph>
        <strong>Vendor:</strong> {p.businessName}
        <br />
        <strong>Amount due:</strong> {formatRand(p.amount)}
        <br />
        <strong>Was due:</strong> {p.dueDate}
        <br />
        <strong>Overdue by:</strong> {p.daysOver} day{p.daysOver === 1 ? '' : 's'}
      </Paragraph>
      <Button href={PORTAL_URL}>Log in and pay now</Button>
      <Paragraph>
        Your portal shows the amount and the payment options available to you. Stalls are only confirmed once
        payment is received in full, and unpaid stalls are released for reallocation.
      </Paragraph>
      <Paragraph>If you have already paid, thank you, and please ignore this message.</Paragraph>
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
  paid_at: string | null; status: string | null
  preferred_booth_tier: string | null; special_requirements: unknown
}

async function main() {
  const sel = 'id,business_name,contact_name,email,phone,admin_notes,reviewed_at,paid_at,status,preferred_booth_tier,special_requirements'
  const res = await fetch(`${BASE}/rest/v1/vendor_applications?status=eq.approved&select=${sel}&limit=1000`, { headers: h })
  if (!res.ok) { console.error('QUERY FAILED', res.status, await res.text()); process.exit(1) }
  const all = (await res.json()) as Row[]

  let rows = all.filter((r) => {
    const st = parsePortalState(r.admin_notes)
    if (hasPaid(st) || r.paid_at) return false
    if (isChaseSuppressed(st)) return false          // a promised deferral is honoured
    const due = computePaymentDue(r)
    const n = daysUntil(due)
    return n !== null && n < 0                       // OVERDUE ONLY
  })
  if (ONLY) rows = rows.filter((r) => (r.business_name || '').trim().toLowerCase() === ONLY)

  console.log(`\n${DRY ? 'DRY RUN, nothing sent' : 'LIVE SEND'} — ${rows.length} overdue vendor(s)\n${'='.repeat(64)}`)

  let waOk = 0, mailOk = 0, recorded = 0
  const fails: string[] = []

  for (const r of rows) {
    const st = parsePortalState(r.admin_notes)
    const due = computePaymentDue(r)!
    const dueStr = fmtDate(due)
    const daysOver = Math.abs(daysUntil(due) ?? 0)
    const amount = Number(st.payment?.amount
      ?? computeVendorPricing({ preferred_booth_tier: r.preferred_booth_tier as string, special_requirements: r.special_requirements }).total
      ?? 0)
    const first = (r.contact_name || 'there').trim().split(/\s+/)[0] || 'there'
    const biz = (r.business_name || '').trim()
    const body = waBody(amount, dueStr, daysOver)
    const prior = ((st as unknown) as { payment_reminders?: { history?: unknown[] } }).payment_reminders?.history || []

    console.log(`\n### ${biz}  (${first}, ${formatRand(amount)}, was due ${dueStr}, ${daysOver}d over, ${prior.length} prior reminder(s))`)
    console.log(`  WA    -> ${r.phone}: Hi ${first}! ${body.slice(0, 120)}...`)
    console.log(`  EMAIL -> ${r.email}: "Overdue, your YAH Festival stall fee, ${biz}"`)

    if (DRY) continue

    let sentSomething = false
    try {
      const wr = await sendTemplate(toE164(r.phone || ''), 'festival_announcement', [first, body], { category: 'utility' })
      if (wr.skipped) fails.push(`WA ${biz}: skipped ${wr.skipped}`)
      else { waOk++; sentSomething = true; console.log('  WA sent') }
    } catch (e) { fails.push(`WA ${biz}: ${(e as Error).message}`) }

    if (r.email) {
      const er = await sendEmail({
        to: r.email,
        subject: `Overdue, your YAH Festival stall fee, ${biz}`,
        react: OverdueEmail({ contactName: r.contact_name || first, businessName: biz, amount, dueDate: dueStr, daysOver }),
      })
      if (er.ok) { mailOk++; sentSomething = true; console.log('  EMAIL sent') }
      else fails.push(`EMAIL ${biz}: ${er.error}`)
    } else fails.push(`EMAIL ${biz}: no email on file`)

    // Record ONLY when something actually left. A record with no send makes the
    // Monday cron skip a vendor who received nothing; a canary caught exactly
    // that on 2026-07-24.
    if (!sentSomething) { fails.push(`RECORD ${biz}: skipped, nothing sent`); continue }
    // updatePortalStateImpl is a PURE encoder, (notes, state) => notes. It does
    // not talk to the database. Calling it as if it wrote was my bug, and tsc
    // caught it before this ran: the record would have thrown, Monday's cron
    // would have seen no contact, and these vendors would have been chased a
    // third time. APPEND to history, never replace, or the week counter resets
    // and the tone ladder restarts.
    const cur = ((st as unknown) as { payment_reminders?: { history?: { at: string; week: number }[]; due_date?: string } }).payment_reminders || {}
    const hist = cur.history || []
    const nextState = {
      ...st,
      payment_reminders: {
        ...cur,
        history: [...hist, { at: new Date().toISOString(), week: Math.min(hist.length + 1, 4) }],
        due_date: due.toISOString(),
      },
    }
    const newNotes = updatePortalStateImpl(r.admin_notes || '', nextState as never)
    const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ admin_notes: newNotes }),
    })
    if (pr.ok) { recorded++; console.log('  history recorded') }
    else fails.push(`RECORD ${biz}: ${pr.status} ${await pr.text()}`)

    await new Promise((r) => setTimeout(r, 300)) // Law 5: stay under the send rate
  }

  console.log(`\n${'='.repeat(64)}`)
  console.log(`${DRY ? 'DRY RUN complete' : 'SENT'}: ${rows.length} vendors | WA ${waOk} | email ${mailOk} | recorded ${recorded}`)
  if (fails.length) { console.log(`\n${fails.length} problem(s):`); fails.forEach((f) => console.log(`  ${f}`)) }
}

main().catch((e) => { console.error(e); process.exit(1) })
