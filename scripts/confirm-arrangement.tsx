// Correct the two vendors who were TOLD they could settle at the end of August
// and then received a Batch 1 final notice anyway (2026-07-25).
//
// Also records the arrangement so it survives this session: payment.status
// 'deferred' plus a payment.arrangement block (until / agreed_at / note).
// scripts/chase-all-unpaid.tsx and scripts/chase-batch.tsx already treat
// 'deferred' as do-not-chase.
//
// KNOWN GAP: src/app/api/cron/payment-reminders/route.ts:89 skips only
// status === 'paid', so the cron will still chase these two when their 7 day
// gap elapses. That one-line fix has to ship before ~1 Aug or this promise
// breaks itself. Flagged to the operator 2026-07-25.
//
//   node --env-file=.env.local --import tsx scripts/confirm-arrangement.tsx          # DRY
//   SEND=1 node --env-file=.env.local --import tsx scripts/confirm-arrangement.tsx   # send

import { config } from 'dotenv'
config({ path: '.env.local' })

import { sendTemplate, toE164, whatsappConfigured } from '../src/lib/whatsapp'
import { sendEmail } from '../src/lib/email/resend'
import { parsePortalState, updatePortalStateImpl } from '../src/lib/portal-state'
import { formatRand } from '../src/lib/payments/pricing'
import { EmailLayout, Heading, Paragraph, Button, Signoff, Divider } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
const PORTAL = 'https://cthalaal.co.za/exhibitor/portal/payments'
const UNTIL = '2026-08-31'

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

type Fix = { key: string; first: string; amount: number; subject: string; lead: string; wa: string; note: string }

const FIXES: Fix[] = [
  {
    key: 'cellxpress and toyxpress', first: 'Farhan', amount: 6500,
    subject: 'Farhan, our mistake, your end of August arrangement stands',
    note: 'Told on WhatsApp 19-20 July he could settle in full at end of August; confirmed again 23 and 25 July. Sent a final notice in error on 25 July.',
    lead: 'You were told on our WhatsApp line that you could settle the full amount at the end of August, and you confirmed that with us again this week. Despite that, you received a final notice from us today. That was our error and we are sorry. The arrangement stands: your stall is held, and the balance is due in full by 31 August 2026. You are welcome to settle any part of it sooner in your portal if that suits you.',
    wa: 'You were told on this line that you could settle the full R6 500 at the end of August, and you confirmed it with us again this week. Despite that, you received a final notice from us today. That was our error and we are sorry. The arrangement stands: your stall is held and the balance is due in full by 31 August 2026. You can settle any part sooner here if it suits you: ' + PORTAL + '.',
  },
  {
    key: 'en vogue cpt', first: 'Abdullah', amount: 12000,
    subject: 'Abdullah, our mistake, your end of August arrangement stands',
    note: 'Asked 14 July for a 50/50 split, agreed on WhatsApp 20 July to pay in full at end of August. Sent a final notice in error on 25 July.',
    lead: 'You asked us on 14 July about paying half now and the balance later, and on 20 July you told us you would make full payment at the end of August instead. Despite that, you received a final notice from us today. That was our error and we are sorry. The arrangement stands: your stall is held, and the balance is due in full by 31 August 2026.',
    wa: 'You asked on 14 July about a 50 percent split, and on 20 July you told us you would make full payment at the end of August instead. Despite that, you received a final notice from us today. That was our error and we are sorry. The arrangement stands: your stall is held and the R12 000 is due in full by 31 August 2026. You can settle any part sooner here: ' + PORTAL + '.',
  },
]

type Row = { id: string; business_name: string | null; contact_name: string | null; email: string | null; phone: string | null; admin_notes: string | null }

function FixEmail(p: { f: Fix; name: string }) {
  return (
    <EmailLayout preview={p.f.subject}>
      <Heading>Our mistake, and your arrangement stands</Heading>
      <Paragraph>Hi {p.name},</Paragraph>
      <Paragraph>{p.f.lead}</Paragraph>
      <Divider />
      <Paragraph>
        <strong>Amount due:</strong> {formatRand(p.f.amount)}
        <br />
        <strong>Due in full by:</strong> 31 August 2026
        <br />
        <strong>Status:</strong> arrangement confirmed, your stall is held
      </Paragraph>
      <Button href={PORTAL}>Log in to pay</Button>
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
  const url = `${BASE}/rest/v1/vendor_applications?status=eq.approved&select=id,business_name,contact_name,email,phone,admin_notes`
  const all = (await (await fetch(url, { headers: h })).json()) as Row[]

  console.log(`\n${DRY ? 'DRY RUN (nothing sent, nothing written)' : 'LIVE'} — ${FIXES.length} arrangement(s)`)
  console.log(`config: whatsapp=${whatsappConfigured} resend=${!!(process.env.RESEND_API_KEY || '').trim()}`)
  if (!DRY && (!whatsappConfigured || !(process.env.RESEND_API_KEY || '').trim())) {
    console.log('ABORT: a channel is not configured. Use node --env-file=.env.local')
    return
  }

  const fails: string[] = []
  for (const f of FIXES) {
    const rows = all.filter((r) => (r.business_name || '').trim().toLowerCase() === f.key)
    if (!rows.length) { fails.push(`NO ROW for ${f.key}`); continue }
    const r = rows[0]
    console.log(`\n### ${r.business_name} (${f.first}, ${formatRand(f.amount)} by ${UNTIL})`)
    console.log(`  WA    → ${toE164(r.phone || '')}: Hi ${f.first}! ${f.wa}`)
    console.log(`  EMAIL → ${r.email}: "${f.subject}"`)
    console.log(`  STATE → payment.status=deferred, arrangement.until=${UNTIL}`)
    if (DRY) continue

    let sent = false
    try {
      const wr = await sendTemplate(toE164(r.phone || ''), 'festival_announcement', [f.first, f.wa], { category: 'utility' })
      if (wr.skipped) fails.push(`WA ${f.key}: skipped ${wr.skipped}`)
      else { sent = true; console.log(`  WA sent`) }
    } catch (e) { fails.push(`WA ${f.key}: ${(e as Error).message}`) }
    try {
      const er = await sendEmail({ to: r.email!, subject: f.subject, react: FixEmail({ f, name: r.contact_name || f.first }) })
      if (er.ok) { sent = true; console.log(`  EMAIL sent`) } else fails.push(`EMAIL ${f.key}: ${er.error}`)
    } catch (e) { fails.push(`EMAIL ${f.key}: ${(e as Error).message}`) }

    // Record the arrangement only once the vendor has actually been told.
    if (!sent) { fails.push(`STATE ${f.key}: nothing sent, arrangement not recorded`); continue }
    const st = parsePortalState(r.admin_notes)
    const next = {
      ...st,
      payment: {
        ...(st.payment || {}),
        status: 'deferred',
        arrangement: { until: UNTIL, agreed_at: new Date().toISOString(), note: f.note },
      },
    }
    const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ admin_notes: updatePortalStateImpl(r.admin_notes || '', next as never) }),
    })
    if (pr.ok) console.log(`  arrangement recorded (deferred until ${UNTIL})`)
    else fails.push(`STATE ${f.key}: ${pr.status} ${await pr.text()}`)
  }

  console.log(`\n${'='.repeat(66)}`)
  if (fails.length) { console.log(`FAILURES (${fails.length}):`); fails.forEach((x) => console.log(`  - ${x}`)) }
  else if (!DRY) console.log('no failures')
  if (!DRY) console.log('\nREMINDER: the cron still skips only status===paid. Fix route.ts:89 before ~1 Aug.')
}

main().catch((e) => { console.error(e); process.exit(1) })
