// Gentle "log in and pay" reminder to the OVERDUE vendors who have NOT already
// been hit with the cancellation warning. Taona 2026-09-11: "mass email campaign,
// to remind people who are overdue to pay they can log in and pay, if u have
// already paid pls ignore this email."
//
// WHO (all must hold):
//   - status approved, not is_duplicate, has an email
//   - unpaid (hasPaid / paid_at false)
//   - not chase-suppressed (drops withdrawn / active plan / active extension — so
//     someone with an approved arrangement is NOT nagged, that would break it)
//   - OVERDUE (reviewed_at + 30 < today)
//   - NOT already cancellation-warned (⟦CANCELWARN⟧): the 33 got the blunt "we are
//     cancelling your stall" yesterday; this gentle email would contradict that.
//   => the 37 general-overdue + the 1 fresher who was overdue but never warned.
//
// "If you have already paid, please ignore this email" is only true because the
// target list is computed at send time and each vendor's paid status is re-checked
// on a FRESH read right before the send (a vendor who pays mid-batch is skipped).
//
// IDEMPOTENT / RESUMABLE (Law 5): ⟦PAYREMIND:2026-09-11⟧ marker on admin_notes on
// a confirmed (not-suppressed) send; skip-if-present, fresh-read before write.
// Resend, confirmDelivery on (KT #206657). Law 7: no long dashes.
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/_overdue-pay-reminder-2026-09-11.tsx          # DRY RUN
//   ONLY="Angelpie" SEND=1 node --env-file=.env.local --import tsx scripts/_overdue-pay-reminder-2026-09-11.tsx  # canary
//   SEND=1 node --env-file=.env.local --import tsx scripts/_overdue-pay-reminder-2026-09-11.tsx  # live

import { config } from 'dotenv'
config({ path: '.env.local' })

import { sendEmail } from '../src/lib/email/resend'
import { parsePortalState, hasPaid, isChaseSuppressed } from '../src/lib/portal-state'
import { computePaymentDue, daysUntil, fmtDate } from '../src/lib/exhibitor-paygate'
import { vendorBill } from '../src/lib/payments/vendor-bill'
import { formatRand } from '../src/lib/payments/pricing'
import { EmailLayout, Heading, Paragraph, Button, Signoff, Divider } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
const MARKER = '⟦PAYREMIND:2026-09-11⟧'
const PORTAL_URL = 'https://cthalaal.co.za/exhibitor/login'

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

function PayReminderEmail(p: { name: string; businessName: string; amount: number; dueDate: string; daysOver: number }) {
  return (
    <EmailLayout preview={`Your stall fee is overdue, ${p.businessName}, log in and pay`}>
      <Heading>Your stall fee is overdue</Heading>
      <Paragraph>Hi {p.name},</Paragraph>
      <Paragraph>
        Your stall fee for the Young at Heart Festival 2026 is overdue. Please log in to your exhibitor portal
        and complete your payment today.
      </Paragraph>
      <Divider />
      <Paragraph>
        <strong>Vendor:</strong> {p.businessName}
        <br />
        <strong>Amount due:</strong> {formatRand(p.amount)}
        <br />
        <strong>Was due:</strong> {p.dueDate} ({p.daysOver} day{p.daysOver === 1 ? '' : 's'} ago)
      </Paragraph>
      <Button href={PORTAL_URL}>Log in and pay</Button>
      <Paragraph>
        Your stall is only secured once payment is received in full.
      </Paragraph>
      <Paragraph>If you have already paid, please ignore this email.</Paragraph>
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
  admin_notes: string | null; reviewed_at: string | null; paid_at: string | null
  status: string | null; is_duplicate: boolean | null
  preferred_booth_tier: string | null; special_requirements: unknown
}

const assertNoDash = (s: string, where: string) => { if (/[–—]/.test(s)) throw new Error(`DASH in ${where}: ${s}`) }

// Test/demo accounts (internal CTH addresses, e.g. demo-vendor@cthalaal.co.za) are
// never emailed to a "vendor" at all.
const isTestAccount = (r: Row) => /demo|test/i.test(r.business_name || '') || /@cthalaal\.co\.za$/i.test((r.email || '').trim())

function target(r: Row): boolean {
  if (r.is_duplicate) return false
  if (!(r.email || '').trim()) return false
  if (isTestAccount(r)) return false
  const st = parsePortalState(r.admin_notes)
  if (hasPaid(st) || r.paid_at) return false
  if (isChaseSuppressed(st)) return false
  // ANY arrangement (plan or extension), even one whose first date just lapsed:
  // a plan exists, so a nag contradicts it. These are flagged to the operator
  // separately, not emailed here. (Haadiya Bakes: approved plan due 10 Sep,
  // now 1 day past.)
  if (st.payment?.arrangement) return false
  if ((r.admin_notes || '').includes('⟦CANCELWARN')) return false // already got the blunt warning
  if ((r.admin_notes || '').includes(MARKER)) return false
  const due = computePaymentDue({ reviewed_at: r.reviewed_at })
  const n = daysUntil(due)
  return n !== null && n < 0
}

async function main() {
  const sel = 'id,business_name,contact_name,email,admin_notes,reviewed_at,paid_at,status,is_duplicate,preferred_booth_tier,special_requirements'
  const res = await fetch(`${BASE}/rest/v1/vendor_applications?status=eq.approved&select=${sel}&limit=1000`, { headers: h })
  if (!res.ok) { console.error('QUERY FAILED', res.status, await res.text()); process.exit(1) }
  const all = (await res.json()) as Row[]
  let rows = all.filter(target)
  // Dedupe by recipient email: the same person with two applications gets ONE
  // email, not two (Soapretty had a duplicate-person row). Keep the first.
  const seenEmail = new Set<string>()
  rows = rows.filter((r) => { const e = (r.email || '').toLowerCase(); if (seenEmail.has(e)) return false; seenEmail.add(e); return true })
  if (ONLY) rows = rows.filter((r) => (r.business_name || '').trim().toLowerCase() === ONLY)

  console.log(`\n${DRY ? 'DRY RUN, nothing sent' : 'LIVE SEND'} — ${rows.length} overdue, not-yet-warned vendor(s)\n${'='.repeat(70)}`)

  let mailOk = 0, marked = 0
  const fails: string[] = []
  const assertNoDash = (s: string, where: string) => { if (/[–—]/.test(s)) throw new Error(`DASH in ${where}: ${s}`) }

  for (const r of rows) {
    const b = vendorBill({ id: r.id, preferred_booth_tier: r.preferred_booth_tier, special_requirements: r.special_requirements, admin_notes: r.admin_notes, paid_at: r.paid_at })
    const amount = b.owing
    const due = computePaymentDue({ reviewed_at: r.reviewed_at })!
    const daysOver = Math.abs(daysUntil(due) ?? 0)
    const first = (r.contact_name || '').trim().split(/\s+/)[0] || (r.business_name || 'there').trim()
    const biz = (r.business_name || '').trim()
    const subject = 'Your stall fee is overdue, log in and pay'
    assertNoDash(subject, 'subject'); assertNoDash(biz, 'business_name'); assertNoDash(first, 'name')

    console.log(`\n### ${biz}  (to: ${first} <${r.email}>, ${formatRand(amount)} owed, was due ${fmtDate(due)}, ${daysOver}d over)`)
    if (DRY) continue

    const er = await sendEmail({
      to: r.email!, subject,
      react: PayReminderEmail({ name: first, businessName: biz, amount, dueDate: fmtDate(due), daysOver }),
      confirmDelivery: true,
    })
    if (!er.ok) { fails.push(`EMAIL ${biz}: ${er.error}`); continue }
    if (er.suppressed) { fails.push(`EMAIL ${biz}: suppressed by Resend, NOT delivered (not marked)`); continue }
    mailOk++; console.log('  email sent')

    const g = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}&select=admin_notes`, { headers: h })
    const cur = g.ok ? (((await g.json())[0] as { admin_notes?: string })?.admin_notes || '') : (r.admin_notes || '')
    if (cur.includes(MARKER)) { marked++; continue }
    const newNotes = `${cur}${cur.endsWith('\n') || cur === '' ? '' : ' '}${MARKER}`
    const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ admin_notes: newNotes }),
    })
    if (pr.ok) { marked++; console.log('  marked PAYREMIND') }
    else fails.push(`MARK ${biz}: ${pr.status} ${await pr.text()}`)

    await new Promise((res) => setTimeout(res, 300)) // Law 5: stay under the send rate
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log(`${DRY ? 'DRY RUN complete' : 'SENT'}: targeted ${rows.length} | email ok ${mailOk} | marked ${marked}`)
  if (fails.length) { console.log(`\n${fails.length} problem(s):`); fails.forEach((f) => console.log(`  ${f}`)) }
}

main().catch((e) => { console.error(e); process.exit(1) })
