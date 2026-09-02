// Day-2 follow-up for the vendors who did not respond to yesterday's
// happy-new-month chase (2026-08-01 batch).
//
// Re-derives the silent set AT SEND TIME so anyone who paid, uploaded proof,
// or replied in the meantime is excluded. Deduplicates merged rows (one
// message per channel per person), uses the utility payment template for the
// numbers Meta marketing-blocked yesterday, records reminder history on every
// row so nobody is double-chased today.
//
//   node --import tsx scripts/_followup-silent-2026-08-02.tsx          # dry run
//   SEND=1 node --import tsx scripts/_followup-silent-2026-08-02.tsx   # live

import { config } from 'dotenv'
config({ path: '.env.local' })

import { parsePortalState, updatePortalStateImpl } from '../src/lib/portal-state'
import { computeVendorPricing, formatRand } from '../src/lib/payments/pricing'
import { computePaymentDue, fmtDate } from '../src/lib/exhibitor-paygate'
import { hasEftMarker } from '../src/lib/eft'
import { EmailLayout, Heading, Paragraph, Button, Signoff, Divider } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
const SINCE = '2026-08-01T07:00:00Z'
const PORTAL_URL = 'https://cthalaal.co.za/exhibitor/portal/payments'
const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

// Numbers Meta marketing-blocked on yesterday's send -> utility template instead.
const MARKETING_BLOCKED = new Set(['27813117723', '27637496665', '27698611583', '27797026206', '27817534892'])

type Row = {
  id: string; business_name: string | null; contact_name: string | null; email: string | null
  phone: string | null; admin_notes: string | null; paid_at: string | null
  preferred_booth_tier: string | null; special_requirements: unknown
  status: string | null; reviewed_at: string | null
}

function e164(p?: string | null): string {
  if (!p) return ''
  let digits = (p || '').replace(/\D/g, '')
  if (digits.length === 9 && !digits.startsWith('0')) digits = '0' + digits
  if (digits.startsWith('0')) digits = '27' + digits.slice(1)
  if (!/^27\d{9}$/.test(digits)) return ''
  return '+' + digits
}

function overdueText(due: Date | null): string {
  if (!due) return 'is due now'
  const days = Math.ceil((due.getTime() - Date.now()) / 86400000)
  if (days < 0) return `is now ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
  return `is due on ${fmtDate(due)}`
}

function FollowUpEmail(p: { contactName: string; businessName: string; amount: number; dueStr: string; overdue: string }) {
  return (
    <EmailLayout preview={`Following up, your stall fee, ${p.businessName}`}>
      <Heading>Following up on your stall fee</Heading>
      <Paragraph>Hi {p.contactName},</Paragraph>
      <Paragraph>
        Following up on yesterday's note. Your stall fee for the Young at Heart Festival {p.overdue.replace(/^is /, 'is ')}.
        Clearing it today secures your spot before it is offered to the waiting list.
      </Paragraph>
      <Divider />
      <Paragraph>
        <strong>Vendor:</strong> {p.businessName}
        <br />
        <strong>Amount due:</strong> {formatRand(p.amount)}
        <br />
        <strong>Due date:</strong> {p.dueStr}
      </Paragraph>
      <Button href={PORTAL_URL}>Log in and pay</Button>
      <Paragraph>Log in to your exhibitor portal to pay: {PORTAL_URL}</Paragraph>
      <Paragraph>If you have already paid, thank you, and please ignore this message.</Paragraph>
      <Signoff>
        Warm regards,
        <br />
        <strong>The Young at Heart Festival Team</strong>
      </Signoff>
    </EmailLayout>
  )
}

async function main() {
  const { sendTemplate } = await import('../src/lib/whatsapp')
  const { sendEmail } = await import('../src/lib/email/resend')

  const res = await fetch(`${BASE}/rest/v1/vendor_applications?status=eq.approved&select=id,business_name,contact_name,email,phone,admin_notes,paid_at,preferred_booth_tier,special_requirements,status,reviewed_at&limit=1000`, { headers: h })
  const all = (await res.json()) as Row[]

  // Chased yesterday + still unpaid + not EFT-lane + no response since.
  type Target = { rows: Row[]; first: string; biz: string; amount: number; due: Date | null; phones: string[]; emails: string[] }
  const targets: Target[] = []
  for (const r of all) {
    const st = parsePortalState(r.admin_notes)
    const hist = ((st as unknown as { payment_reminders?: { history?: Array<{ at: string }> } }).payment_reminders?.history) || []
    if (!hist.some((e) => String(e.at || '').startsWith('2026-08-01'))) continue
    const pay = st.payment || {}
    if (r.paid_at && r.paid_at >= SINCE) continue
    if (pay.status === 'paid' || pay.status === 'collected') continue
    if (['eft_submitted_at', 'eft_collected_at', 'eft_revealed_at'].some((k) => (pay as Record<string, string | undefined>)[k] && ((pay as Record<string, string>)[k] >= SINCE))) continue
    if (hasEftMarker(r.admin_notes)) continue
    if (Object.keys(pay).some((k) => /^eft/i.test(k))) continue

    // Any inbound since the chase? (WA or email) — responded means skip.
    const digits = String(r.phone || '').replace(/\D/g, '')
    const last9 = digits.slice(-9)
    let responded = false
    if (last9.length === 9) {
      const rw = await fetch(`${BASE}/rest/v1/wa_messages?wa_phone=like.*${last9}&direction=eq.in&created_at=gte.${SINCE}&select=id&limit=1`, { headers: h })
      if (((await rw.json()) || []).length) responded = true
    }
    const em = String(r.email || '').trim().toLowerCase()
    if (!responded && em) {
      const rt = await fetch(`${BASE}/rest/v1/support_inbox_threads?peer_email=ilike.${encodeURIComponent(em)}&select=id`, { headers: h })
      const ids = ((await rt.json()) || []).map((t: { id: string }) => t.id)
      if (ids.length) {
        const rm = await fetch(`${BASE}/rest/v1/support_inbox_messages?thread_id=in.(${ids.join(',')})&direction=eq.in&created_at=gte.${SINCE}&select=id&limit=1`, { headers: h })
        if (((await rm.json()) || []).length) responded = true
      }
    }
    if (responded) continue

    // Merge into an existing target by shared email or phone (dedupe duplicates).
    const phone = e164(r.phone)
    const existing = targets.find((t) => (em && t.emails.includes(em)) || (phone && t.phones.includes(phone)))
    const amount = (st.payment?.amount as number | undefined) ?? computeVendorPricing({ preferred_booth_tier: r.preferred_booth_tier, special_requirements: r.special_requirements }).total
    const due = computePaymentDue({ payment_due_date: null, reviewed_at: r.reviewed_at })
    if (existing) {
      existing.rows.push(r)
      if (em && !existing.emails.includes(em)) existing.emails.push(em)
      if (phone && !existing.phones.includes(phone)) existing.phones.push(phone)
    } else {
      targets.push({
        rows: [r],
        first: (r.contact_name || 'there').trim().split(/\s+/)[0] || 'there',
        biz: (r.business_name || '').trim(),
        amount,
        due,
        phones: phone ? [phone] : [],
        emails: em ? [em] : [],
      })
    }
  }

  console.log(`${DRY ? 'DRY RUN' : 'LIVE'} — ${targets.length} silent follow-up targets`)
  let waOk = 0, mailOk = 0, recorded = 0
  const fails: string[] = []

  for (const t of targets) {
    const over = overdueText(t.due)
    const dueStr = t.due ? fmtDate(t.due) : 'TBC'
    const waBody = `Following up on yesterday's note: your stall fee of ${formatRand(t.amount)} for the Young at Heart Festival ${over}. Spots are being released to the waiting list as fees come in, so please clear yours today. Log in and pay here: ${PORTAL_URL}.`
    const subject = `Following up, your YAH Festival stall fee, ${t.biz}`

    const phone = t.phones[0]
    const email = t.emails[0]
    console.log(`\n### ${t.biz} (${t.first}, ${formatRand(t.amount)}, ${over})`)
    console.log(`  WA    -> ${phone || '(none)'}`)
    console.log(`  EMAIL -> ${email || '(none)'}`)
    if (DRY) continue

    let sent = false
    if (phone) {
      const digits = phone.replace(/\D/g, '')
      try {
        const wr = MARKETING_BLOCKED.has(digits)
          ? await sendTemplate(phone, 'vendor_payment_reminder', [t.first, formatRand(t.amount), dueStr], { category: 'utility' })
          : await sendTemplate(phone, 'festival_announcement', [t.first, waBody], { category: 'utility' })
        if (wr.skipped) fails.push(`WA ${t.biz}: skipped ${wr.skipped}`)
        else { waOk++; sent = true; console.log('  WA sent') }
      } catch (e) { fails.push(`WA ${t.biz}: ${(e as Error).message}`) }
    }
    if (email) {
      try {
        const er = await sendEmail({
          to: email,
          subject,
          react: FollowUpEmail({ contactName: t.rows[0].contact_name || t.first, businessName: t.biz, amount: t.amount, dueStr, overdue: over }),
        })
        if (er.ok) { mailOk++; sent = true; console.log('  EMAIL sent') }
        else fails.push(`EMAIL ${t.biz}: ${er.error}`)
      } catch (e) { fails.push(`EMAIL ${t.biz}: ${(e as Error).message}`) }
    }

    if (sent) {
      for (const r of t.rows) {
        const st = parsePortalState(r.admin_notes)
        const prior = ((st as unknown as { payment_reminders?: { history?: Array<{ at: string; week: number }> } }).payment_reminders?.history) || []
        const nextState = {
          ...st,
          payment_reminders: {
            ...(((st as unknown) as { payment_reminders?: Record<string, unknown> }).payment_reminders || {}),
            history: [...prior, { at: new Date().toISOString(), week: Math.min(prior.length + 1, 4) }],
            due_date: t.due?.toISOString(),
          },
        }
        const newNotes = updatePortalStateImpl(r.admin_notes || '', nextState as never)
        const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}`, {
          method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ admin_notes: newNotes }),
        })
        if (pr.ok) recorded++
        else fails.push(`RECORD ${t.biz} (${r.id}): ${pr.status}`)
      }
      await new Promise((res) => setTimeout(res, 250))
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${DRY ? 'DRY RUN complete' : 'SENT'}: ${targets.length} vendors | WA ${waOk} | email ${mailOk} | history rows ${recorded}`)
  if (fails.length) { console.log(`\nFAILURES (${fails.length}):`); fails.forEach((f) => console.log(`  ${f}`)) }
}

main().catch((e) => { console.error(e); process.exit(1) })
