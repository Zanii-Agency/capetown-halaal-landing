// One-time CANCELLATION-WARNING email to the overdue NEW-VENDOR cohort (freshers
// hand-flipped onto master EFT, tagged ⟦NEWVENDOR⟧). Taona 2026-09-10: "email them"
// after seeing + approving the copy and confirming the outstanding figure includes
// accessories.
//
// WHO IT TARGETS (all four must hold):
//   - status approved, not is_duplicate
//   - hasNewVendorMarker  (the flipped-fresher cohort only, never a normal vendor)
//   - unpaid AND not chase-suppressed (isChaseSuppressed drops paid / withdrawn /
//     an active arrangement — so a vendor who already arranged a deferral is NOT
//     threatened with cancellation)
//   - OVERDUE by (payment.due plan-date if set, else reviewed_at + 30) < today
//   => exactly the "35 due" shown to Taona (minus anyone who becomes suppressed).
//
// AMOUNT = vendorBill.owing = full outstanding = stall + accessories (verified
// 2026-09-10: 11 of the cohort carry accessories, 0 integrity mismatches).
//
// IDEMPOTENT / RESUMABLE (Law 5): a ⟦CANCELWARN:2026-09-10⟧ marker is appended to
// admin_notes on a confirmed send; anyone already carrying it is skipped, so a
// re-run after a partial failure never double-emails. The marker is re-read fresh
// per row right before the write, so a concurrent edit in this shared checkout is
// not clobbered. Covert cohort => the marker never reaches the festival owner.
//
// EMAIL ONLY (Taona: "email them"). Resend, DKIM-signed, confirmDelivery on so a
// silently-suppressed recipient is reported and NOT marked (KT #206657).
// Law 7: commas / periods / colons, no long dashes anywhere.
//
// Usage:
//   node --import tsx scripts/_newvendor-cancel-warning-2026-09-10.tsx                 # DRY RUN, sends nothing
//   ONLY="HappyFeet" SEND=1 node --import tsx scripts/_newvendor-cancel-warning-2026-09-10.tsx   # canary, one vendor
//   SEND=1 node --import tsx scripts/_newvendor-cancel-warning-2026-09-10.tsx          # live send

import { config } from 'dotenv'
config({ path: '.env.local' })

import { sendEmail } from '../src/lib/email/resend'
import { parsePortalState, hasPaid, isChaseSuppressed } from '../src/lib/portal-state'
import { hasNewVendorMarker } from '../src/lib/eft'
import { vendorBill } from '../src/lib/payments/vendor-bill'
import { computePaymentDue, daysUntil, fmtDate } from '../src/lib/exhibitor-paygate'
import { formatRand } from '../src/lib/payments/pricing'
import { EmailLayout, Heading, Paragraph, Button, Signoff, Divider } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
const MARKER = '⟦CANCELWARN:2026-09-10⟧'
const WA_E164 = '27659435012'
const WA_PREFILL = 'Hi, I would like to request a payment plan for my stall.'
const WA_LINK = `https://wa.me/${WA_E164}?text=${encodeURIComponent(WA_PREFILL)}`

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

function CancelWarningEmail(p: { name: string; businessName: string; amount: number; daysOver: number }) {
  return (
    <EmailLayout preview={`Your stall is being cancelled, ${p.businessName}, please read`}>
      <Heading>We are cancelling your stall</Heading>
      <Paragraph>Hi {p.name},</Paragraph>
      <Paragraph>
        This is a message about your stall application for the Young at Heart Festival 2026.
      </Paragraph>
      <Divider />
      <Paragraph>
        <strong>Vendor:</strong> {p.businessName}
        <br />
        <strong>Days overdue:</strong> {p.daysOver} day{p.daysOver === 1 ? '' : 's'}
        <br />
        <strong>Outstanding balance:</strong> {formatRand(p.amount)}
      </Paragraph>
      <Paragraph>
        You are currently {p.daysOver} day{p.daysOver === 1 ? '' : 's'} past your payment due date, and your
        outstanding balance is {formatRand(p.amount)}. We are now finalising the stalls for the festival, so we
        need to hear from you.
      </Paragraph>
      <Paragraph>
        Please let us know if we should continue to cancel your stall as an outstanding application.
      </Paragraph>
      <Paragraph>
        If you are struggling with the payment but you are still interested in trading with us, you do not lose
        your place. Message us on WhatsApp and ask for a payment plan, and we will set one up with you.
      </Paragraph>
      <Button href={WA_LINK}>Message us on WhatsApp for a payment plan</Button>
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

// Due date matching the report shown to Taona: plan date (payment.due) wins, else
// reviewed_at + 30.
function dueFor(r: Row) {
  const p = parsePortalState(r.admin_notes).payment
  const planDue = p?.due ? new Date(p.due) : null
  return planDue && !isNaN(planDue.getTime()) ? planDue : computePaymentDue(r)
}

async function main() {
  const sel = 'id,business_name,contact_name,email,admin_notes,reviewed_at,paid_at,status,is_duplicate,preferred_booth_tier,special_requirements'
  const res = await fetch(`${BASE}/rest/v1/vendor_applications?status=eq.approved&select=${sel}&limit=1000`, { headers: h })
  if (!res.ok) { console.error('QUERY FAILED', res.status, await res.text()); process.exit(1) }
  const all = (await res.json()) as Row[]

  const excluded: string[] = []
  let rows = all.filter((r) => {
    if (r.is_duplicate) return false
    if (!hasNewVendorMarker(r.admin_notes)) return false
    const st = parsePortalState(r.admin_notes)
    if (hasPaid(st) || r.paid_at) { excluded.push(`${r.business_name}: paid`); return false }
    if (isChaseSuppressed(st)) { excluded.push(`${r.business_name}: arrangement/withdrawn`); return false }
    const due = dueFor(r)
    const n = daysUntil(due)
    if (n === null || n >= 0) return false // OVERDUE ONLY
    if ((r.admin_notes || '').includes(MARKER)) { excluded.push(`${r.business_name}: already warned`); return false }
    if (!r.email) { excluded.push(`${r.business_name}: no email`); return false }
    return true
  })
  if (ONLY) rows = rows.filter((r) => (r.business_name || '').trim().toLowerCase() === ONLY)

  console.log(`\n${DRY ? 'DRY RUN, nothing sent' : 'LIVE SEND'} — ${rows.length} overdue new-vendor(s)\n${'='.repeat(70)}`)

  let mailOk = 0, marked = 0
  const fails: string[] = []
  // Law 7 guard: no long/en dash may reach a vendor.
  const assertNoDash = (s: string, where: string) => { if (/[–—]/.test(s)) throw new Error(`DASH in ${where}: ${s}`) }

  for (const r of rows) {
    const b = vendorBill({ id: r.id, preferred_booth_tier: r.preferred_booth_tier, special_requirements: r.special_requirements, admin_notes: r.admin_notes, paid_at: r.paid_at })
    const amount = b.owing
    const due = dueFor(r)!
    const daysOver = Math.abs(daysUntil(due) ?? 0)
    const first = (r.contact_name || '').trim().split(/\s+/)[0] || (r.business_name || 'there').trim()
    const biz = (r.business_name || '').trim()
    const subject = 'We are cancelling your stall, Young at Heart Festival 2026'
    assertNoDash(subject, 'subject'); assertNoDash(biz, 'business_name'); assertNoDash(first, 'name')

    console.log(`\n### ${biz}  (to: ${first} <${r.email}>, ${formatRand(amount)} owed, was due ${fmtDate(due)}, ${daysOver}d over)`)
    if (DRY) continue

    const er = await sendEmail({
      to: r.email!,
      subject,
      react: CancelWarningEmail({ name: first, businessName: biz, amount, daysOver }),
      confirmDelivery: true,
    })
    if (!er.ok) { fails.push(`EMAIL ${biz}: ${er.error}`); continue }
    if (er.suppressed) { fails.push(`EMAIL ${biz}: suppressed by Resend, NOT delivered (not marked, retry later)`); continue }
    mailOk++; console.log('  email sent')

    // Mark on a FRESH read of admin_notes so a concurrent edit is not clobbered.
    const g = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}&select=admin_notes`, { headers: h })
    const cur = g.ok ? (((await g.json())[0] as { admin_notes?: string })?.admin_notes || '') : (r.admin_notes || '')
    if (cur.includes(MARKER)) { marked++; continue }
    const newNotes = `${cur}${cur.endsWith('\n') || cur === '' ? '' : ' '}${MARKER}`
    const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ admin_notes: newNotes }),
    })
    if (pr.ok) { marked++; console.log('  marked CANCELWARN') }
    else fails.push(`MARK ${biz}: ${pr.status} ${await pr.text()}`)

    await new Promise((res) => setTimeout(res, 300)) // Law 5: stay under the send rate
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log(`${DRY ? 'DRY RUN complete' : 'SENT'}: targeted ${rows.length} | email ok ${mailOk} | marked ${marked}`)
  if (excluded.length) { console.log(`\nExcluded ${excluded.length} from the cohort:`); excluded.forEach((e) => console.log(`  ${e}`)) }
  if (fails.length) { console.log(`\n${fails.length} problem(s):`); fails.forEach((f) => console.log(`  ${f}`)) }
}

main().catch((e) => { console.error(e); process.exit(1) })
