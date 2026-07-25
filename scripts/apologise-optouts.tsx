// Apology to the four vendors who told us they were not trading this year and
// were billed anyway (2026-07-25). Three of them received a final notice on
// 25 July; Hermanos Chicken was not chased that day but was never closed out.
//
// Run AFTER scripts/withdraw-optouts.tsx: this script refuses to write to anyone
// still sitting on status='approved', because an apology that promises "your
// application is closed" must not go out before it actually is.
//
// No payment ask, no button, no method named, no em-dashes (Law 7).
// WhatsApp: free-form text where the 24h service window is open (it preserves
// line breaks), falling back to the utility template when it is not.
//
//   node --env-file=.env.local --import tsx scripts/apologise-optouts.tsx          # DRY
//   SEND=1 node --env-file=.env.local --import tsx scripts/apologise-optouts.tsx   # send

import { config } from 'dotenv'
config({ path: '.env.local' })

import { sendText, sendTemplate, toE164, whatsappConfigured } from '../src/lib/whatsapp'
import { sendEmail } from '../src/lib/email/resend'
import { EmailLayout, Heading, Paragraph, Signoff } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
// Retry controls: a transient failure on one channel must not re-send the others.
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
const CHANNEL = (process.env.CHANNEL || 'both').trim().toLowerCase() // both | wa | email

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

type Note = { key: string; first: string; wa: boolean; subject: string; heading: string; body: string[] }

const NOTES: Note[] = [
  {
    key: 'layali haus', first: 'Ibtesaam', wa: true,
    subject: 'Our apology, your Layali Haus application is now closed',
    heading: 'Our apology, and your application is now closed',
    body: [
      'You told us on 6 July that Layali Haus would not be attending this year, and you told us again on 20 July and again today.',
      'You should never have received today’s payment notice, and you should not have had to tell us three times. That was our mistake and we are sorry.',
      'Your application is now formally closed, the stall fee is cancelled, you owe us nothing, and the reminders stop here.',
      'Thank you for letting us know so early, and we hope to see Layali Haus at a future Young at Heart Festival.',
    ],
  },
  {
    key: 'the meeaad range', first: 'Shadika', wa: true,
    subject: 'Our apology, your MeeAad Range application is now closed',
    heading: 'Our apology, and your application is now closed',
    body: [
      'You cancelled your space on 20 July, confirmed it on our WhatsApp line, and emailed us again on 23 July.',
      'We told you the team would close it out and then we did not, so today you received a payment notice you should never have seen. We are sorry.',
      'Your application is now formally closed, the stall fee is cancelled, and you owe us nothing.',
      'Safe travels, and we would love to have The MeeAad Range with us another year.',
    ],
  },
  {
    key: 'second season', first: 'Taariq', wa: false,
    subject: 'Our apology, your Second Season application is now closed',
    heading: 'Our apology, and your application is now closed',
    body: [
      'You asked on 23 July to have your application removed for this year and we did not action it, so today you received a payment notice instead. We are sorry.',
      'Your application is now formally closed, the stall fee is cancelled, and you owe us nothing.',
      'Thank you for letting us know, and we hope to see Second Season at a future festival.',
    ],
  },
  {
    key: 'hermanos chicken', first: 'Shabier', wa: false,
    subject: 'Your Hermanos Chicken application is now closed',
    heading: 'Your application is now closed',
    body: [
      'You let us know on 13 July that you cannot make the festival this year and asked us to offer the space to another vendor.',
      'That is now done and your application is formally closed, with nothing outstanding on your side. Our apologies for the delay in confirming it.',
      'We hope to see Hermanos Chicken at a future Young at Heart Festival.',
    ],
  },
]

type Row = { id: string; business_name: string | null; contact_name: string | null; email: string | null; phone: string | null; status: string }

function ApologyEmail(p: { n: Note; name: string }) {
  return (
    <EmailLayout preview={p.n.subject}>
      <Heading>{p.n.heading}</Heading>
      <Paragraph>Hi {p.name},</Paragraph>
      {p.n.body.map((t, i) => (
        <Paragraph key={i}>{t}</Paragraph>
      ))}
      <Signoff>
        Warm regards,
        <br />
        <strong>The Young at Heart Festival Team</strong>
      </Signoff>
    </EmailLayout>
  )
}

async function main() {
  const url = `${BASE}/rest/v1/vendor_applications?select=id,business_name,contact_name,email,phone,status`
  const all = (await (await fetch(url, { headers: h })).json()) as Row[]

  console.log(`\n${DRY ? 'DRY RUN (nothing sent)' : 'LIVE SEND'} — ${NOTES.length} apolog${NOTES.length === 1 ? 'y' : 'ies'}`)
  console.log(`config: whatsapp=${whatsappConfigured} resend=${!!(process.env.RESEND_API_KEY || '').trim()}`)
  if (!DRY && (!whatsappConfigured || !(process.env.RESEND_API_KEY || '').trim())) {
    console.log('ABORT: a channel is not configured. Use node --env-file=.env.local')
    return
  }

  // Pass 1: resolve and refuse if the withdrawal has not actually landed.
  const plan: { n: Note; row: Row }[] = []
  const problems: string[] = []
  for (const n of NOTES) {
    if (ONLY && n.key !== ONLY) continue
    const rows = all.filter((r) => (r.business_name || '').trim().toLowerCase() === n.key)
    if (!rows.length) { problems.push(`NO ROW for "${n.key}"`); continue }
    for (const row of rows) {
      if (row.status !== 'rejected') problems.push(`${n.key}: status is "${row.status}", expected "rejected" (run withdraw-optouts first)`)
      if (!row.email) problems.push(`${n.key}: no email on file`)
      plan.push({ n, row })
      console.log(`\n### ${row.business_name} (${n.first})`)
      console.log(`  EMAIL → ${row.email}: "${n.subject}"`)
      console.log(`  WA    → ${n.wa ? toE164(row.phone || '') : '(not applicable, they contacted us by email)'}`)
      if (n.wa) console.log(`          Hi ${n.first}, ${n.body.join(' ')}`)
    }
  }
  if (problems.length) {
    console.log(`\nABORT, ${problems.length} problem(s), nothing sent:`)
    problems.forEach((p) => console.log(`  - ${p}`))
    process.exitCode = 1
    return
  }
  console.log(`\n${'='.repeat(66)}\nvalidated ${plan.length}: all four are closed out`)
  if (DRY) return

  let mailOk = 0, waOk = 0
  const fails: string[] = []
  for (const { n, row } of plan) {
    if (CHANNEL !== 'wa') {
      try {
        const er = await sendEmail({ to: row.email!, subject: n.subject, react: ApologyEmail({ n, name: row.contact_name || n.first }) })
        if (er.ok) { mailOk++; console.log(`  EMAIL sent → ${row.email}`) } else fails.push(`EMAIL ${n.key}: ${er.error}`)
      } catch (e) { fails.push(`EMAIL ${n.key}: ${(e as Error).message}`) }
    }

    if (CHANNEL !== 'email' && n.wa && row.phone) {
      const phone = toE164(row.phone)
      const body = `Hi ${n.first}, ${n.body.join('\n\n')}`
      try {
        // Free-form first: it keeps the paragraph breaks. Outside the 24h service
        // window it comes back skipped, so fall back to the utility template.
        let r = await sendText(phone, body)
        if (r.skipped) {
          console.log(`  WA free-form skipped (${r.skipped}), using template`)
          r = await sendTemplate(phone, 'festival_announcement', [n.first, n.body.join(' ')], { category: 'utility' })
        }
        if (r.skipped) fails.push(`WA ${n.key}: skipped ${r.skipped}`)
        else { waOk++; console.log(`  WA sent → ${phone}`) }
      } catch (e) { fails.push(`WA ${n.key}: ${(e as Error).message}`) }
    }
    await new Promise((res) => setTimeout(res, 250))
  }

  console.log(`\n${'='.repeat(66)}`)
  console.log(`email sent: ${mailOk} | WA sent: ${waOk}`)
  if (fails.length) { console.log(`FAILURES (${fails.length}):`); fails.forEach((f) => console.log(`  - ${f}`)) }
  else console.log('no failures')
}

main().catch((e) => { console.error(e); process.exit(1) })
