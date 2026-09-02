// Custom one-off chase for overdue / unpaid approved vendors.
// Operator-initiated. Sends a tailored email + WhatsApp and records the contact
// so the cron and future chases do not double-message the same person today.
//
// Usage:
//   node --import tsx scripts/chase-overdue-unpaid-custom.tsx                       # DRY RUN, all unpaid
//   OVERDUE_ONLY=1 node --import tsx scripts/chase-overdue-unpaid-custom.tsx        # DRY RUN, overdue only
//   SEND=1 OVERDUE_ONLY=1 node --import tsx scripts/chase-overdue-unpaid-custom.tsx # LIVE, overdue only
//   SEND=1 MAX_VENDORS=43 node --import tsx scripts/chase-overdue-unpaid-custom.tsx # LIVE, cap at 43
//   ONLY="Business Name" ...                                                        # canary one vendor
//
// Messaging rule: never name a payment method (EFT/Yoco/bank). Portal handles it.

import { config } from 'dotenv'
config({ path: '.env.local' })

import { parsePortalState, updatePortalStateImpl, isChaseSuppressed } from '../src/lib/portal-state'
import { computeVendorPricing, formatRand } from '../src/lib/payments/pricing'
import { isTestVendor } from '../src/lib/test-vendors'
import { hasEftMarker } from '../src/lib/eft'
import { computePaymentDue, daysUntil, fmtDate } from '../src/lib/exhibitor-paygate'
import { EmailLayout, Heading, Paragraph, Button, Signoff, Divider } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
const OVERDUE_ONLY = process.env.OVERDUE_ONLY === '1'
const MAX_VENDORS = process.env.MAX_VENDORS ? Number(process.env.MAX_VENDORS) : undefined
const NEW_MONTH = process.env.NEW_MONTH === '1'
const PORTAL_URL = 'https://cthalaal.co.za/exhibitor/portal/payments'
const FINAL_EXTENSION_DATE = new Date('2026-08-31T21:59:59.999Z')

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

type Row = {
  id: string
  business_name: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  admin_notes: string | null
  reviewed_at: string | null
  paid_at: string | null
  status: string | null
  preferred_booth_tier: string | null
  special_requirements: unknown
}

type HistEntry = { at: string; week: number }

function historyOf(st: ReturnType<typeof parsePortalState>): HistEntry[] {
  return ((st as unknown) as { payment_reminders?: { history?: HistEntry[] } }).payment_reminders?.history || []
}

function isPaid(st: ReturnType<typeof parsePortalState>, row: Row): boolean {
  const settled = new Set(['paid', 'waived', 'collected'])
  return !!row.paid_at || settled.has(st.payment?.status || '')
}

function remindedToday(history: HistEntry[]): boolean {
  if (!history.length) return false
  const last = new Date(history[history.length - 1].at)
  const today = new Date()
  return (
    last.getUTCFullYear() === today.getUTCFullYear() &&
    last.getUTCMonth() === today.getUTCMonth() &&
    last.getUTCDate() === today.getUTCDate()
  )
}

function hasExtensionToAug31(st: ReturnType<typeof parsePortalState>): boolean {
  const arr = st.payment?.arrangement
  if (!arr?.until) return false
  return new Date(`${arr.until}T23:59:59.999Z`) >= FINAL_EXTENSION_DATE
}

// Vendors who were told in chat/email/notes that they have until 31 August 2026
// should NOT get an overdue chase, even if the operator didn't record it as a
// formal portal_state deferral. This scans the same sources the timeline uses.
const EXTENSION_PHRASE_RE = new RegExp(
  '\\b(have|got|given|extension|extend|extended|till|until|settle|pay)\\b[^.!?]{0,60}\\b31\\s*(august|aug)(\\s*2026)?\\b|' +
  '\\b31\\s*(august|aug)(\\s*2026)?\\b[^.!?]{0,60}\\b(have|got|given|extension|extend|extended|till|until|settle|pay)\\b',
  'i'
)

function proseFromNotes(notes?: string | null): string {
  return String(notes || '')
    .replace(/⟦STALL:[^⟧]+⟧/g, '')
    .replace(/⟦PORTAL:[^⟧]+⟧/g, '')
    .replace(/⟦DOCS:[^⟧]+⟧/g, '')
    .replace(/⟦CONTRACT_SIGNED⟧/g, '')
    .replace(/⟦PAID⟧/g, '')
    .replace(/⟦EFT⟧/g, '')
    .replace(/⟦NOEFT⟧/g, '')
    .replace(/⟦OWNERVIS⟧/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The vendor's own words only. Email replies quote our reminder, and the quote
// carries OUR lines ("Prefer EFT... Reply to this email") which must not be
// read as the vendor asking. Drop ">" quoted lines and cut at the reply header
// / forward marker, the same rule the inbox uses.
function stripQuotedReply(text: string): string {
  const kept: string[] = []
  for (const line of String(text || '').split('\n')) {
    if (/^\s*>/.test(line)) continue
    if (/^\s*On\s.{0,120}\bwrote:\s*$/i.test(line)) break
    if (/^-{2,}\s*Forwarded message\s*-{2,}/i.test(line)) break
    kept.push(line)
  }
  return kept.join('\n')
}

async function gatherCommsTexts(row: Row): Promise<string[]> {
  const texts: string[] = []

  // Admin notes prose.
  texts.push(proseFromNotes(row.admin_notes))

  // vendor_application_events. Lane-management actions (eft_lane_exclude etc.)
  // are OUR bookkeeping, not a vendor request — skip them or an explicit
  // "exclude from EFT lane" action reads as an EFT ask.
  try {
    const events = (await (await fetch(`${BASE}/rest/v1/vendor_application_events?application_id=eq.${row.id}&select=event_type,note,after_value`, { headers: h })).json()) as Array<{ event_type?: string; note?: string; after_value?: unknown }>
    for (const e of events) {
      if (/^eft_lane/i.test(e.event_type || '')) continue
      texts.push(`${e.event_type || ''} ${e.note || ''} ${JSON.stringify(e.after_value || {})}`)
    }
  } catch { /* swallow */ }

  // WhatsApp messages by last-9 phone.
  const digits = String(row.phone || '').replace(/\D/g, '')
  const last9 = digits.slice(-9)
  if (last9.length >= 9) {
    try {
      const msgs = (await (await fetch(`${BASE}/rest/v1/wa_messages?wa_phone=like.*${last9}&select=direction,body`, { headers: h })).json()) as Array<{ direction?: string; body?: string }>
      for (const m of msgs) if (m.body) texts.push(`${m.direction === 'in' ? 'VENDOR: ' : 'US: '}${m.body}`)
    } catch { /* swallow */ }
  }

  // Support inbox email messages (quote-stripped so our own reminder copy is
  // never mistaken for the vendor's words).
  const email = String(row.email || '').trim().toLowerCase()
  if (email) {
    try {
      const threads = (await (await fetch(`${BASE}/rest/v1/support_inbox_threads?peer_email=ilike.${encodeURIComponent(email)}&select=id`, { headers: h })).json()) as Array<{ id: string }>
      if (threads.length) {
        const ids = threads.map((t) => t.id).join(',')
        const msgs = (await (await fetch(`${BASE}/rest/v1/support_inbox_messages?thread_id=in.(${ids})&select=direction,body_text`, { headers: h })).json()) as Array<{ direction?: string; body_text?: string }>
        for (const m of msgs) if (m.body_text) texts.push(`${m.direction === 'in' ? 'VENDOR: ' : 'US: '}${stripQuotedReply(m.body_text)}`)
      }
    } catch { /* swallow */ }
  }

  // mail_messages (outbound to the vendor — prefix as US so the EFT-request
  // scan never mistakes our own wording for a vendor request).
  if (email) {
    try {
      const msgs = (await (await fetch(`${BASE}/rest/v1/mail_messages?to_addr=ilike.${encodeURIComponent(email)}&select=body_text,subject`, { headers: h })).json()) as Array<{ body_text?: string; subject?: string }>
      for (const m of msgs) texts.push(`US: ${m.subject || ''} ${stripQuotedReply(m.body_text || '')}`)
    } catch { /* swallow */ }
  }

  return texts
}

// Vendors with an OPEN EFT request are handled manually (Samreen / master lane).
// Chasing them for card payment is wrong and leaks the lane. The scan matches
// the vendor's OWN inbound messages plus team notes for an EFT ask — outbound
// "we are card only" answers are prefixed "US:" and deliberately NOT matched,
// so a vendor who asked once and accepted the card answer is still chaseable.
const EFT_REQUEST_RE = /\beft\b|electronic funds transfer|bank transfer|bank details|pay(?:ing)? by bank|deposit (?:into|to)|direct(?:ly)? (?:to|into) (?:your|the) account/i

// A granted extension is not always "31 August". If WE told them "make payment
// by the 4th of August" (Kgotsos Pride, emergency, agreed 2026-07-27), chasing
// them before that date directly contradicts our own message. Matches OUR
// outbound texts only.
const GRANTED_AUG_RE = /(make payment|pay|settle)[^.!?]{0,50}\bby\b[^.!?]{0,25}\b\d{1,2}(?:st|nd|rd|th)?\s*(?:of\s*)?aug(?:ust)?\b/i

// Compliance: a stop request is not a chase target, ever. zaytoon.za:
// "Please stop send message to this email" (2026-07-29). Vendor texts only.
const STOP_RE = /\bplease stop\b|\bstop (send|sending|mail|email|messag)/i

// An open installment/payment-plan proposal awaiting our answer is not a
// generic chase target (Baby Republic proposed a 4-part plan on 2026-07-31).
// Narrow on purpose: a plain "can I pay part?" question is NOT matched.
const PLAN_PROPOSAL_RE = /\bpropos\w*\b[^.!?]{0,80}\b(install|instal)ment/i

function waBody(firstName: string, amount: number, dueStr: string, daysOver: number): string {
  const over = Math.abs(daysOver)
  const overdueText = daysOver < 0
    ? `is now ${over} day${over === 1 ? '' : 's'} overdue`
    : `is due on ${dueStr}`
  if (NEW_MONTH) {
    // festival_announcement already renders "Hi {{1}}!" before this body, so
    // the body itself must not open with the vendor's name again.
    return `Happy new month! Your stall fee of ${formatRand(amount)} for the Young at Heart Festival ${overdueText}. ` +
      `Clear it now to secure your spot before it goes to the waiting list. ` +
      `Log in and pay here: ${PORTAL_URL}.`
  }
  return `Your stall fee of ${formatRand(amount)} for the Young at Heart Festival ${overdueText}. ` +
    `Please log in to your exhibitor portal and complete your payment today: ${PORTAL_URL}. ` +
    `Your stall is only secured once payment is received in full.`
}

function ChaseEmail(p: { contactName: string; businessName: string; amount: number; dueDate: string; daysOver: number; newMonth?: boolean }) {
  const overdue = p.daysOver < 0
  const over = Math.abs(p.daysOver)
  const preview = p.newMonth
    ? `Happy new month, secure your stall, ${p.businessName}`
    : `Your stall fee is ${overdue ? over + ' days overdue' : 'due soon'}, ${p.businessName}`
  const heading = p.newMonth
    ? 'Happy new month, secure your stall'
    : overdue ? 'Your stall fee is overdue' : 'Your stall fee is due soon'
  const lead = p.newMonth
    ? 'We wish you a happy new month. Your stall fee for the Young at Heart Festival is ' +
      (p.daysOver < 0 ? `${Math.abs(p.daysOver)} day${Math.abs(p.daysOver) === 1 ? '' : 's'} overdue` : `due on ${p.dueDate}`) +
      '. Clear it now to secure your spot before it goes to the waiting list.'
    : overdue
      ? 'Your stall fee for the Young at Heart Festival has passed its due date. Please settle it today so your place at the festival is secured.'
      : 'Your stall fee for the Young at Heart Festival is due soon. Please settle it to secure your place at the festival.'
  const closing = p.newMonth
    ? `Log in to your exhibitor portal to pay: ${PORTAL_URL}`
    : 'Your portal shows the amount and the payment options available to you. Stalls are only confirmed once payment is received in full.'
  return (
    <EmailLayout preview={preview}>
      <Heading>{heading}</Heading>
      <Paragraph>Hi {p.contactName},</Paragraph>
      <Paragraph>{lead}</Paragraph>
      <Divider />
      <Paragraph>
        <strong>Vendor:</strong> {p.businessName}
        <br />
        <strong>Amount due:</strong> {formatRand(p.amount)}
        <br />
        <strong>Due date:</strong> {p.dueDate}
        <br />
        <strong>Status:</strong> {overdue ? `${over} day${over === 1 ? '' : 's'} overdue` : 'due soon'}
      </Paragraph>
      <Button href={PORTAL_URL}>Log in and pay now</Button>
      <Paragraph>{closing}</Paragraph>
      <Paragraph>If you have already paid, thank you, and please ignore this message.</Paragraph>
      <Signoff>
        Warm regards,
        <br />
        <strong>The Young at Heart Festival Team</strong>
      </Signoff>
    </EmailLayout>
  )
}

function buildTarget(rows: Row[], today: Date, e164: (p?: string | null) => string) {
  const enriched = rows.map((r) => {
    const st = parsePortalState(r.admin_notes)
    const due = computePaymentDue(r)
    const amount = st.payment?.amount ?? computeVendorPricing({ preferred_booth_tier: r.preferred_booth_tier, special_requirements: r.special_requirements }).total
    return { r, st, due, amount }
  })
  enriched.sort((a, b) => ((b.due?.getTime() ?? 0) - (a.due?.getTime() ?? 0)))
  const p = enriched[0]
  const prior = historyOf(p.st)
  const daysOver = p.due ? (daysUntil(p.due) ?? 0) : 0
  const first = (p.r.contact_name || 'there').trim().split(/\s+/)[0] || 'there'
  const phones = [...new Set(rows.map((r) => e164(r.phone)).filter(Boolean))]
  const emails = [...new Set(rows.map((r) => (r.email || '').trim()).filter(Boolean))]
  return {
    primary: p.r,
    rows,
    phones,
    emails,
    first,
    biz: (p.r.business_name || '').trim(),
    amount: p.amount,
    due: p.due,
    daysOver,
    prior,
    st: p.st,
  }
}

async function main() {
  // Load whatsapp + email AFTER dotenv config() ran, so module-level env reads see keys.
  const { sendTemplate, toE164: libToE164 } = await import('../src/lib/whatsapp')
  const { sendEmail } = await import('../src/lib/email/resend')
  const e164lib = (p?: string | null): string => {
    try {
      if (!p) return ''
      let digits = (p || '').replace(/\D/g, '')
      // Some rows lost their leading zero ("829513366"). Treat a 9-digit local
      // number as 0... before E.164 conversion.
      if (digits.length === 9 && !digits.startsWith('0')) digits = '0' + digits
      const out = libToE164(digits)
      const d = out.replace(/\D/g, '')
      // Only send WhatsApp to a valid South African number. Corrupt or
      // international numbers are skipped here so the email leg still sends.
      if (!/^27\d{9}$/.test(d)) return ''
      return out
    } catch { return '' }
  }

  const today = new Date()
  const sel = 'id,business_name,contact_name,email,phone,admin_notes,reviewed_at,paid_at,status,preferred_booth_tier,special_requirements'
  const res = await fetch(`${BASE}/rest/v1/vendor_applications?status=eq.approved&select=${sel}&limit=1000`, { headers: h })
  if (!res.ok) { console.error('QUERY FAILED', res.status, await res.text()); process.exit(1) }
  const all = (await res.json()) as Row[]

  const excluded: Record<string, string[]> = {
    paid: [], test: [], deferred: [], eft: [], no_due: [], ext_aug31: [],
  }

  // Per-row filter removes ONLY test rows. Every person-level predicate (paid,
  // deferred, extension, EFT, no-due) runs at GROUP level after the duplicate
  // merge: the marker/state can sit on a duplicate row of the same person, and
  // filtering per-row keeps the unmarked twin and chases a vendor who already
  // paid or already sent proof. Melonscape, 2026-07-31: PaymentNotification.pdf
  // via WhatsApp 13:04, ⟦EFT⟧ on the OTHER row — the per-row filter chased her.
  let rows = all.filter((r) => {
    if (isTestVendor(r)) { excluded.test.push(r.business_name || r.id); return false }
    return true
  })

  if (ONLY) rows = rows.filter((r) => (r.business_name || '').trim().toLowerCase() === ONLY)

  // De-dupe by real person.
  const uf = rows.map((_, i) => i)
  const find = (x: number): number => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x] } return x }
  const union = (a: number, b: number) => { uf[find(a)] = find(b) }
  const byEmail = new Map<string, number>()
  const byPhone = new Map<string, number>()
  rows.forEach((r, i) => {
    const em = (r.email || '').trim().toLowerCase()
    const ph = e164lib(r.phone)
    if (em) { if (byEmail.has(em)) union(i, byEmail.get(em)!); else byEmail.set(em, i) }
    if (ph) { if (byPhone.has(ph)) union(i, byPhone.get(ph)!); else byPhone.set(ph, i) }
  })
  const comp = new Map<number, Row[]>()
  rows.forEach((r, i) => { const root = find(i); const g = comp.get(root) || []; g.push(r); comp.set(root, g) })

  let targets = [...comp.values()].map((group) => buildTarget(group, today, e164lib))

  // Person-level predicates at GROUP level. If ANY duplicate row of the same
  // person is paid / deferred / extended / EFT, the PERSON is. The group's
  // comms below already scan every row's phone+email for the same reason.
  targets = targets.filter((t) => {
    const any = (fn: (r: Row) => boolean) => t.rows.some(fn)
    if (any((r) => isPaid(parsePortalState(r.admin_notes), r))) { excluded.paid.push(t.biz); return false }
    if (any((r) => isChaseSuppressed(parsePortalState(r.admin_notes)))) { excluded.deferred.push(t.biz); return false }
    if (any((r) => hasExtensionToAug31(parsePortalState(r.admin_notes)))) { excluded.ext_aug31.push(t.biz); return false }
    // EFT: the ⟦EFT⟧ marker OR any eft_* stamp in portal state (eft_revealed_at
    // means they have seen the bank details; eft proof stamps mean they sent
    // POP). Either way the person is being handled on the master lane.
    if (any((r) => {
      if (hasEftMarker(r.admin_notes)) return true
      const p = (parsePortalState(r.admin_notes) as unknown as { payment?: Record<string, unknown> }).payment || {}
      return Object.keys(p).some((k) => /^eft/i.test(k))
    })) { excluded.eft.push(t.biz); return false }
    if (!t.due) { excluded.no_due.push(t.biz); return false }
    return true
  })

  // Exclude anyone told they have until 31 August 2026, AND anyone with an open
  // EFT request (handled manually by Samreen / the master lane — chasing them
  // for card payment is wrong and leaks the lane). One comms scan per vendor,
  // both checks run on the same texts.
  const skippedExtFromComms: string[] = []
  const skippedEftFromComms: string[] = []
  const skippedGranted: string[] = []
  const skippedStop: string[] = []
  const skippedPlan: string[] = []
  // Scan comms for EVERY row of the group, not just the primary: a duplicate
  // can carry a different email (Melonscape: adnanc2008@ vs rabiamocho@) and
  // the extension/EFT/stop signal can live on either one.
  const commsTexts = await Promise.all(
    targets.map((t) => Promise.all(t.rows.map((r) => gatherCommsTexts(r))).then((a) => a.flat()))
  )
  targets = targets.filter((t, i) => {
    const texts = commsTexts[i]
    if (texts.some((x) => EXTENSION_PHRASE_RE.test(x))) {
      skippedExtFromComms.push(t.biz); excluded.ext_aug31.push(t.biz); return false
    }
    if (texts.some((x) => !/^US: /.test(x) && EFT_REQUEST_RE.test(x))) {
      skippedEftFromComms.push(t.biz); excluded.eft.push(t.biz); return false
    }
    if (texts.some((x) => /^US: /.test(x) && GRANTED_AUG_RE.test(x))) {
      skippedGranted.push(t.biz); excluded.ext_aug31.push(t.biz); return false
    }
    if (texts.some((x) => /^VENDOR: /.test(x) && STOP_RE.test(x))) {
      skippedStop.push(t.biz); return false
    }
    if (texts.some((x) => /^VENDOR: /.test(x) && PLAN_PROPOSAL_RE.test(x))) {
      skippedPlan.push(t.biz); return false
    }
    return true
  })

  // Exclude anyone reminded today.
  const skippedToday: string[] = []
  targets = targets.filter((t) => {
    if (remindedToday(t.prior)) { skippedToday.push(t.biz); return false }
    return true
  })

  // Exclude anyone missing both channels.
  const skippedNoContact: string[] = []
  targets = targets.filter((t) => {
    if (t.emails.length === 0 && t.phones.length === 0) { skippedNoContact.push(t.biz); return false }
    return true
  })

  // Optional: overdue only.
  const skippedNotOverdue: string[] = []
  if (OVERDUE_ONLY) {
    targets = targets.filter((t) => {
      if (t.daysOver >= 0) { skippedNotOverdue.push(t.biz); return false }
      return true
    })
  }

  // Sort: most overdue first.
  targets.sort((a, b) => a.daysOver - b.daysOver)

  // Apply cap.
  const capped = MAX_VENDORS !== undefined && targets.length > MAX_VENDORS
  const selected = MAX_VENDORS !== undefined ? targets.slice(0, MAX_VENDORS) : targets
  const droppedForCap = MAX_VENDORS !== undefined ? targets.length - selected.length : 0

  const overdueN = selected.filter((t) => t.daysOver < 0).length
  const soonN = selected.filter((t) => t.daysOver >= 0).length

  console.log(`\n${DRY ? 'DRY RUN (nothing sent)' : 'LIVE SEND'} — ${selected.length} target(s)`)
  if (OVERDUE_ONLY) console.log('  MODE: overdue only')
  if (MAX_VENDORS !== undefined) console.log(`  CAP: ${MAX_VENDORS} vendors${capped ? ` (${droppedForCap} excluded by cap)` : ''}`)
  console.log(`  overdue: ${overdueN} | due soon: ${soonN}`)
  console.log(`  skipped today: ${skippedToday.length} | no contact: ${skippedNoContact.length} | ext to 31 Aug: ${skippedExtFromComms.length} | EFT request in comms: ${skippedEftFromComms.length} | granted Aug date: ${skippedGranted.length} | stop request: ${skippedStop.length} | open plan proposal: ${skippedPlan.length}${OVERDUE_ONLY ? ` | not overdue: ${skippedNotOverdue.length}` : ''}`)
  console.log('='.repeat(70))

  console.log(`\nExclusions:`)
  console.log(`  paid/collected/waived: ${excluded.paid.length}`)
  console.log(`  deferred: ${excluded.deferred.length}`)
  console.log(`  extension to 31 Aug (portal state): ${excluded.ext_aug31.length - skippedExtFromComms.length}`)
  console.log(`  extension to 31 Aug (chats/notes/mail): ${skippedExtFromComms.length}`)
  console.log(`  EFT lane (marker + open EFT request in comms): ${excluded.eft.length}`)
  console.log(`  test/demo: ${excluded.test.length}`)
  console.log(`  no due date: ${excluded.no_due.length}`)

  if (excluded.ext_aug31.length) console.log(`\n!!! Vendors with extension to 31 Aug (excluded from this chase):\n  ${excluded.ext_aug31.join('\n  ')}`)
  if (skippedEftFromComms.length) console.log(`\n!!! Vendors with an open EFT request in comms (excluded, handled manually):\n  ${skippedEftFromComms.join('\n  ')}`)
  if (skippedGranted.length) console.log(`\n!!! Vendors WE granted a specific August date (excluded):\n  ${skippedGranted.join('\n  ')}`)
  if (skippedStop.length) console.log(`\n!!! Vendors who asked us to STOP messaging (excluded, compliance):\n  ${skippedStop.join('\n  ')}`)
  if (skippedPlan.length) console.log(`\n!!! Vendors with an OPEN payment-plan proposal awaiting an answer (excluded):\n  ${skippedPlan.join('\n  ')}`)
  if (skippedToday.length) console.log('\nSkipped (already reminded today):\n  ' + skippedToday.join('\n  '))
  if (skippedNoContact.length) console.log('\nSkipped (no email or phone):\n  ' + skippedNoContact.join('\n  '))
  if (skippedExtFromComms.length) console.log('\nSkipped (extension to 31 Aug found in chats/notes/mail):\n  ' + skippedExtFromComms.join('\n  '))
  if (OVERDUE_ONLY && skippedNotOverdue.length) console.log('\nSkipped (not overdue):\n  ' + skippedNotOverdue.slice(0, 20).join('\n  ') + (skippedNotOverdue.length > 20 ? `\n  ... and ${skippedNotOverdue.length - 20} more` : ''))

  let waOk = 0, mailOk = 0, recorded = 0
  const fails: string[] = []

  for (const t of selected) {
    const dueStr = t.due ? fmtDate(t.due) : 'TBC'
    const overdue = t.daysOver < 0
    const over = Math.abs(t.daysOver)
    const body = waBody(t.first, t.amount, dueStr, t.daysOver)
    const subject = NEW_MONTH
      ? `Happy new month, secure your stall at Young at Heart Festival 2026`
      : overdue
        ? `Overdue, your YAH Festival stall fee, ${t.biz}`
        : `Reminder, your YAH Festival stall fee, ${t.biz}`

    console.log(`\n### ${t.biz}  (${t.first}, ${formatRand(t.amount)}, due ${dueStr}, ${overdue ? `${over}d overdue` : `${t.daysOver}d left`}, ${t.prior.length} prior reminder(s))`)
    console.log(`  WA    -> ${t.phones[0] || '(none)'}${t.phones.length > 1 ? ` (+${t.phones.length - 1} alt phone skipped)` : ''}: Hi ${t.first}! ${body.slice(0, 120)}...`)
    console.log(`  EMAIL -> ${t.emails[0] || '(none)'}${t.emails.length > 1 ? ` (+${t.emails.length - 1} alt email skipped)` : ''}: "${subject}"`)

    if (DRY) continue

    let sentSomething = false
    // ONE message per channel per person. A merged group can carry two phones
    // or two inboxes for the same human (Chocotag has two emails) — sending to
    // both is a duplicate on the same day, and it would also break the 60-email
    // cap. First valid address wins; the rest stay untouched.
    const phone = t.phones[0]
    if (phone) {
      try {
        const wr = await sendTemplate(phone, 'festival_announcement', [t.first, body], { category: 'utility' })
        if (wr.skipped) fails.push(`WA ${t.biz} (${phone}): skipped ${wr.skipped}`)
        else { waOk++; sentSomething = true; console.log(`  WA sent -> ${phone}`) }
      } catch (e) { fails.push(`WA ${t.biz} (${phone}): ${(e as Error).message}`) }
    }

    const email = t.emails[0]
    if (email) {
      try {
        const er = await sendEmail({
          to: email,
          subject,
          react: ChaseEmail({
            contactName: t.primary.contact_name || t.first,
            businessName: t.biz,
            amount: t.amount,
            dueDate: dueStr,
            daysOver: t.daysOver,
            newMonth: NEW_MONTH,
          }),
        })
        if (er.ok) { mailOk++; sentSomething = true; console.log(`  EMAIL sent -> ${email}`) }
        else fails.push(`EMAIL ${t.biz} (${email}): ${er.error}`)
      } catch (e) { fails.push(`EMAIL ${t.biz} (${email}): ${(e as Error).message}`) }
    }

    if (!sentSomething) { fails.push(`RECORD ${t.biz}: nothing sent`); continue }

    // Record history on every row for this person.
    for (const r of t.rows) {
      const st = parsePortalState(r.admin_notes)
      const prior = historyOf(st)
      const week = Math.min(prior.length + 1, 4)
      const nextState = {
        ...st,
        payment_reminders: {
          ...(((st as unknown) as { payment_reminders?: Record<string, unknown> }).payment_reminders || {}),
          history: [...prior, { at: new Date().toISOString(), week }],
          due_date: t.due?.toISOString(),
        },
      }
      const newNotes = updatePortalStateImpl(r.admin_notes || '', nextState as never)
      const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ admin_notes: newNotes }),
      })
      if (pr.ok) { recorded++; console.log(`  history recorded -> ${r.id}`) }
      else fails.push(`RECORD ${t.biz} (${r.id}): ${pr.status} ${await pr.text()}`)
    }
    await new Promise((res) => setTimeout(res, 250))
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log(`${DRY ? 'DRY RUN complete' : 'SENT'}: ${selected.length} vendors | WA ${waOk} | email ${mailOk} | history rows recorded ${recorded}`)
  if (fails.length) { console.log(`\nFAILURES (${fails.length}):`); fails.forEach((f) => console.log(`  ${f}`)) }
}

main().catch((e) => { console.error(e); process.exit(1) })
