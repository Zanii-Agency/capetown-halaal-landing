// FINAL NOTICE follow-up to the new-vendor cancellation cohort who were warned
// on 10 Sep (⟦CANCELWARN:2026-09-10⟧) and have NOT responded since. Taona
// 2026-09-12: "send the follow up to the silent 32".
//
// THE LEVER THE FIRST EMAIL LACKED: a deadline. "We are cancelling" with no date
// is a threat with no clock; this adds the clock and keeps the same payment-plan
// escape over WhatsApp.
//
// WHO (all must hold, computed FRESH at send time so it self-corrects):
//   - carries ⟦CANCELWARN:2026-09-10⟧ (was warned)
//   - still unpaid (hasPaid / paid_at false)
//   - NOT chase-suppressed (dropped: withdrawn / a plan or extension arranged since)
//   - NO inbound WhatsApp or email from them since 10 Sep (any engagement = not silent)
//   - NOT already sent this follow-up (⟦CANCELFOLLOW:2026-09-12⟧)
//   - has an email, not a test/demo account
//   => the 32 silent, minus anyone who has moved since the monitor ran.
//
// IDEMPOTENT / RESUMABLE (Law 5): ⟦CANCELFOLLOW:2026-09-12⟧ marker on a confirmed
// (not-suppressed) send; skip-if-present, fresh-read before write. Resend,
// confirmDelivery on. Law 7: no long dashes.
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/_newvendor-cancel-followup-2026-09-12.tsx          # DRY RUN
//   ONLY="HappyFeet" SEND=1 node --env-file=.env.local --import tsx scripts/_newvendor-cancel-followup-2026-09-12.tsx  # canary
//   SEND=1 node --env-file=.env.local --import tsx scripts/_newvendor-cancel-followup-2026-09-12.tsx  # live

import { config } from 'dotenv'
config({ path: '.env.local' })

import { sendEmail } from '../src/lib/email/resend'
import { parsePortalState, hasPaid, isChaseSuppressed } from '../src/lib/portal-state'
import { vendorBill } from '../src/lib/payments/vendor-bill'
import { computePaymentDue, daysUntil } from '../src/lib/exhibitor-paygate'
import { formatRand } from '../src/lib/payments/pricing'
import { EmailLayout, Heading, Paragraph, Button, Signoff, Divider } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
const WARN_MARKER = '⟦CANCELWARN:2026-09-10⟧'
const MARKER = '⟦CANCELFOLLOW:2026-09-12⟧'
const SINCE = '2026-09-10T00:00:00Z'
const DEADLINE = 'Friday 18 September 2026'
const WA_E164 = '27659435012'
const WA_LINK = `https://wa.me/${WA_E164}?text=${encodeURIComponent('Hi, I would like to request a payment plan for my stall.')}`
const last9 = (p: string) => (p || '').replace(/\D/g, '').slice(-9)

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

function FinalNoticeEmail(p: { name: string; businessName: string; amount: number }) {
  return (
    <EmailLayout preview={`Final notice: your stall will be cancelled on ${DEADLINE}, ${p.businessName}`}>
      <Heading>Final notice: your stall will be cancelled</Heading>
      <Paragraph>Hi {p.name},</Paragraph>
      <Paragraph>
        We wrote to you on 10 September about your stall application for the Young at Heart Festival 2026, and
        we have not heard back.
      </Paragraph>
      <Divider />
      <Paragraph>
        <strong>Vendor:</strong> {p.businessName}
        <br />
        <strong>Outstanding balance:</strong> {formatRand(p.amount)}
      </Paragraph>
      <Paragraph>
        This is a final notice. If we do not hear from you by <strong>{DEADLINE}</strong>, your stall will be
        cancelled and released.
      </Paragraph>
      <Paragraph>
        If you are struggling with the payment but you still want to trade with us, you do not lose your place.
        Message us on WhatsApp and ask for a payment plan, and we will set one up with you.
      </Paragraph>
      <Button href={WA_LINK}>Message us on WhatsApp for a payment plan</Button>
      <Paragraph>If you have already paid, thank you, and please ignore this email.</Paragraph>
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
  phone: string | null; admin_notes: string | null; reviewed_at: string | null; paid_at: string | null
  status: string | null; is_duplicate: boolean | null
  preferred_booth_tier: string | null; special_requirements: unknown
}

async function main() {
  // Inbound engagement since the warning: WhatsApp (by last-9 phone) + email (by peer_email).
  const waIn = new Set<string>()
  try {
    const r = await fetch(`${BASE}/rest/v1/wa_messages?direction=eq.in&created_at=gte.${encodeURIComponent(SINCE)}&select=wa_phone&limit=5000`, { headers: h })
    if (r.ok) for (const m of (await r.json()) as Array<{ wa_phone: string }>) waIn.add(last9(m.wa_phone))
  } catch { /* best-effort */ }
  const mailIn = new Set<string>()
  try {
    const tr = await fetch(`${BASE}/rest/v1/support_inbox_threads?select=id,peer_email&limit=5000`, { headers: h })
    const threads = tr.ok ? ((await tr.json()) as Array<{ id: string; peer_email: string }>) : []
    const byId = new Map(threads.map(t => [t.id, (t.peer_email || '').toLowerCase()]))
    // Batch the thread ids: all 700+ in one `in.()` makes a ~28KB URL that
    // PostgREST rejects with 400, silently returning NO inbound messages (which
    // would mark every replied vendor "silent"). 50 per request stays well under
    // the URL limit.
    for (let i = 0; i < threads.length; i += 50) {
      const ids = threads.slice(i, i + 50).map(t => t.id).join(',')
      const mr = await fetch(`${BASE}/rest/v1/support_inbox_messages?thread_id=in.(${ids})&direction=eq.in&created_at=gte.${encodeURIComponent(SINCE)}&select=thread_id&limit=5000`, { headers: h })
      if (!mr.ok) continue
      for (const m of (await mr.json()) as Array<{ thread_id: string }>) { const e = byId.get(m.thread_id); if (e) mailIn.add(e) }
    }
  } catch { /* best-effort */ }

  const sel = 'id,business_name,contact_name,email,phone,admin_notes,reviewed_at,paid_at,status,is_duplicate,preferred_booth_tier,special_requirements'
  const res = await fetch(`${BASE}/rest/v1/vendor_applications?status=eq.approved&select=${sel}&limit=1000`, { headers: h })
  if (!res.ok) { console.error('QUERY FAILED', res.status, await res.text()); process.exit(1) }
  const all = (await res.json()) as Row[]

  const dropped: string[] = []
  let rows = all.filter((r) => {
    const notes = r.admin_notes || ''
    if (!notes.includes(WARN_MARKER)) return false
    if (notes.includes(MARKER)) return false
    if (r.is_duplicate) { dropped.push(`${r.business_name}: dup`); return false }
    if (!(r.email || '').trim()) { dropped.push(`${r.business_name}: no email`); return false }
    if (/demo|test/i.test(r.business_name || '') || /@cthalaal\.co\.za$/i.test((r.email || '').trim())) { dropped.push(`${r.business_name}: test`); return false }
    const st = parsePortalState(r.admin_notes)
    if (hasPaid(st) || r.paid_at) { dropped.push(`${r.business_name}: paid`); return false }
    if (isChaseSuppressed(st)) { dropped.push(`${r.business_name}: arrangement/withdrawn`); return false }
    const engaged = waIn.has(last9(r.phone || '')) || mailIn.has((r.email || '').toLowerCase())
    if (engaged) { dropped.push(`${r.business_name}: replied, not silent`); return false }
    return true
  })
  // Dedupe by recipient email.
  const seen = new Set<string>()
  rows = rows.filter((r) => { const e = (r.email || '').toLowerCase(); if (seen.has(e)) { dropped.push(`${r.business_name}: dup email`); return false } seen.add(e); return true })
  if (ONLY) rows = rows.filter((r) => (r.business_name || '').trim().toLowerCase() === ONLY)

  console.log(`\n${DRY ? 'DRY RUN, nothing sent' : 'LIVE SEND'} — ${rows.length} silent warned vendor(s)\n${'='.repeat(70)}`)

  let mailOk = 0, marked = 0
  const fails: string[] = []
  const assertNoDash = (s: string, where: string) => { if (/[–—]/.test(s)) throw new Error(`DASH in ${where}: ${s}`) }

  for (const r of rows) {
    const b = vendorBill({ id: r.id, preferred_booth_tier: r.preferred_booth_tier, special_requirements: r.special_requirements, admin_notes: r.admin_notes, paid_at: r.paid_at })
    const amount = b.owing
    const first = (r.contact_name || '').trim().split(/\s+/)[0] || (r.business_name || 'there').trim()
    const biz = (r.business_name || '').trim()
    const subject = 'Final notice: your stall will be cancelled'
    assertNoDash(subject, 'subject'); assertNoDash(biz, 'business_name'); assertNoDash(first, 'name')

    console.log(`\n### ${biz}  (to: ${first} <${r.email}>, ${formatRand(amount)} owed)`)
    if (DRY) continue

    const er = await sendEmail({ to: r.email!, subject, react: FinalNoticeEmail({ name: first, businessName: biz, amount }), confirmDelivery: true })
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
    if (pr.ok) { marked++; console.log('  marked CANCELFOLLOW') }
    else fails.push(`MARK ${biz}: ${pr.status} ${await pr.text()}`)

    await new Promise((res) => setTimeout(res, 300)) // Law 5
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log(`${DRY ? 'DRY RUN complete' : 'SENT'}: targeted ${rows.length} | email ok ${mailOk} | marked ${marked}`)
  if (dropped.length) { console.log(`\nDropped from the warned cohort (${dropped.length}):`); dropped.forEach((d) => console.log(`  ${d}`)) }
  if (fails.length) { console.log(`\n${fails.length} problem(s):`); fails.forEach((f) => console.log(`  ${f}`)) }
}

main().catch((e) => { console.error(e); process.exit(1) })
