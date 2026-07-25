// One-off SEGMENT-AWARE payment chase to ALL approved-unpaid vendors.
// Operator-initiated (2026-07-25), on top of the auto-reminder cron. Extends
// scripts/_chase-8-eft-reminder.tsx from a fixed 8 to every unpaid vendor, and
// makes the copy conscious of WHO each vendor is and WHEN they were last
// reminded: a never-contacted vendor gets a warm first-touch, a 3x-reminded
// overdue vendor gets a final notice that references the prior contact.
//
// Messaging rule (operator, 2026-07-24): NEVER name a payment method (EFT/Yoco/
// bank). Every message says only: log in and pay at the portal. No em-dashes
// (Law 7). Portal handles the method.
//
// Segment/tone (capped so a not-yet-overdue vendor never gets "final notice"):
//   prior reminders | not yet due / soon      | overdue
//   0                | warm first-touch        | firm intro
//   1-2              | gentle nudge (days left)| "now N days overdue"
//   3+               | reminder (not final)    | FINAL NOTICE, stall at risk
//
// De-dups by real person (normalized email, else E.164 phone) so a duplicated
// application row (e.g. Melonscape) does not message the same person twice; the
// reminder history is still written to every matching row.
//
// Usage (Node 22 — supabase-js realtime breaks on Node 20):
//   node --import tsx scripts/chase-all-unpaid.tsx                         # DRY RUN (default), sends nothing
//   ONLY="CN COLLECTION" SEND=1 node --import tsx scripts/chase-all-unpaid.tsx   # canary, live-send ONE
//   SEND=1 node --import tsx scripts/chase-all-unpaid.tsx                  # live-send all
//   MIN_GAP_DAYS=3 SEND=1 node --import tsx scripts/chase-all-unpaid.tsx   # skip anyone reminded within N days

import { config } from 'dotenv'
config({ path: '.env.local' })

import { sendTemplate, toE164 } from '../src/lib/whatsapp'
import { sendEmail } from '../src/lib/email/resend'
import { parsePortalState, updatePortalStateImpl } from '../src/lib/portal-state'
import { computeVendorPricing, formatRand } from '../src/lib/payments/pricing'
import { isTestVendor } from '../src/lib/test-vendors'
import { EmailLayout, Heading, Paragraph, Button, Signoff, Divider } from '../src/lib/email/components'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
const MIN_GAP_DAYS = process.env.MIN_GAP_DAYS ? Number(process.env.MIN_GAP_DAYS) : 0
const PORTAL_URL = 'https://cthalaal.co.za/exhibitor/portal/payments'
const FINAL_SETTLEMENT = new Date('2026-08-31T21:59:59.999Z') // hard cutoff vendors are held to

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

// Test/demo rows to never message: shared with the crons via lib/test-vendors.

const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 86400000)
const e164 = (p?: string | null): string => { try { return p ? toE164(p) : '' } catch { return '' } }

type Row = {
  id: string; business_name: string | null; contact_name: string | null; email: string | null
  phone: string | null; admin_notes: string | null; reviewed_at: string | null; created_at: string | null
  preferred_booth_tier: string | null; special_requirements: unknown
}

type HistEntry = { at: string; week: number }
type Seg = 'intro' | 'nudge' | 'firm'

// A resolved, de-duplicated vendor ready to message.
type Target = {
  primary: Row
  rows: Row[]           // all rows for this person (history written to all)
  phones: string[]      // distinct E.164 phones (WA once each)
  emails: string[]      // distinct emails (email once each)
  first: string
  biz: string
  amount: number
  due: Date
  daysRemaining: number // negative => overdue
  overdue: boolean
  priorCount: number
  lastAt: Date | null
  reviewedMissing: boolean
  seg: Seg
}

function historyOf(st: ReturnType<typeof parsePortalState>): HistEntry[] {
  return ((st as unknown) as { payment_reminders?: { history?: HistEntry[] } }).payment_reminders?.history || []
}

// 'collected' means an operator confirmed the vendor's money landed: the vendor
// already SEES paid and got an acknowledgment. paid_at stays null only so finance
// does not double-count before Yoco settles (src/lib/portal-state.ts:73). Chasing
// a collected vendor bills someone who has paid, so it counts as paid here.
// 'deferred' is an agreed postponement, which is the opposite of chaseable.
const SETTLED = new Set(['paid', 'waived', 'collected', 'deferred'])
function isPaid(st: ReturnType<typeof parsePortalState>, row: Row): boolean {
  return !!(row as unknown as { paid_at?: string }).paid_at || SETTLED.has(st.payment?.status || '')
}

// Segment tier from prior-reminder count, capped by overdue status downstream.
function segOf(priorCount: number): Seg {
  if (priorCount === 0) return 'intro'
  if (priorCount <= 2) return 'nudge'
  return 'firm'
}

// WhatsApp body. festival_announcement renders "Hi {{1}}! {{2}}", so this must
// NOT start with "Hi". No payment method named. No em-dashes.
function waBody(t: Target): string {
  const amt = formatRand(t.amount)
  const dueStr = fmtDate(t.due)
  const over = Math.abs(t.daysRemaining)
  const lastStr = t.lastAt ? fmtDate(t.lastAt) : ''
  const pay = `Please log in to your exhibitor portal to view and pay: ${PORTAL_URL}. Your stall is only secured once payment is received in full.`
  if (t.seg === 'intro') {
    return t.overdue
      ? `Your stall for the Young at Heart Festival is confirmed, but your stall fee of ${amt} was due on ${dueStr} and is now ${over} day${over === 1 ? '' : 's'} overdue. ${pay}`
      : `A warm welcome to the Young at Heart Festival. Your stall fee of ${amt} is due on ${dueStr}. ${pay}`
  }
  if (t.seg === 'nudge') {
    return t.overdue
      ? `Following up on our note of ${lastStr}. Your stall fee of ${amt} was due on ${dueStr} and is now ${over} day${over === 1 ? '' : 's'} overdue. ${pay}`
      : `Following up on our note of ${lastStr}. Your stall fee of ${amt} is due on ${dueStr}, ${t.daysRemaining} day${t.daysRemaining === 1 ? '' : 's'} from now. ${pay}`
  }
  // firm (3+ prior)
  return t.overdue
    ? `Final notice. Your stall fee of ${amt} has been outstanding since ${dueStr} (${over} day${over === 1 ? '' : 's'} overdue) despite previous reminders. To keep your stall you must settle in full now. ${pay}`
    : `A further reminder that your stall fee of ${amt} is due on ${dueStr}. ${pay}`
}

function emailSubject(t: Target): string {
  return t.seg === 'firm' && t.overdue
    ? `Final notice, stall fee overdue, ${t.biz}`
    : `Reminder, your YAH Festival stall fee, ${t.biz}`
}

function ReminderEmail(t: Target) {
  const amt = formatRand(t.amount)
  const dueStr = fmtDate(t.due)
  const over = Math.abs(t.daysRemaining)
  const lastStr = t.lastAt ? fmtDate(t.lastAt) : ''
  const heading =
    t.seg === 'firm' && t.overdue ? 'Final notice, your stall is at risk'
    : t.overdue ? 'Your stall fee is now overdue'
    : t.seg === 'intro' ? 'A warm welcome, your stall is waiting'
    : 'A friendly reminder, your stall is waiting'
  const statusLine = t.overdue
    ? `${over} day${over === 1 ? '' : 's'} overdue`
    : `${t.daysRemaining} day${t.daysRemaining === 1 ? '' : 's'} remaining`
  const lead =
    t.seg === 'intro'
      ? (t.overdue
          ? 'Your stall is confirmed, but your stall fee is still outstanding and now past its due date. Settle it to keep your spot.'
          : 'Welcome aboard. Your stall fee is due shortly. Settle it to lock in your spot.')
      : t.seg === 'firm' && t.overdue
        ? `This is a final reminder. Your stall fee has been outstanding despite our earlier notes, including on ${lastStr}. Unpaid stalls may be released, so please settle in full now.`
        : `${lastStr ? `Following up on our note of ${lastStr}. ` : ''}Your stall fee is still outstanding. Settle it to keep your spot.`
  return (
    <EmailLayout preview={`Stall fee reminder for ${t.biz}, due ${dueStr}`}>
      <Heading>{heading}</Heading>
      <Paragraph>Hi {t.primary.contact_name || t.first},</Paragraph>
      <Paragraph>{lead}</Paragraph>
      <Divider />
      <Paragraph>
        <strong>Vendor:</strong> {t.biz}
        <br />
        <strong>Amount due:</strong> {amt}
        <br />
        <strong>Due date:</strong> {dueStr}
        <br />
        <strong>Status:</strong> {statusLine}
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

// Build the messaging target from a group of rows for one real person.
function buildTarget(rows: Row[], today: Date): Target {
  // primary = most-progressed row (most reminders), tiebreak earliest due.
  const enriched = rows.map((r) => {
    const st = parsePortalState(r.admin_notes)
    const hist = historyOf(st)
    const reviewedMissing = !r.reviewed_at
    const base = r.reviewed_at ? new Date(r.reviewed_at) : (r.created_at ? new Date(r.created_at) : today)
    const due = new Date(base); due.setDate(due.getDate() + 30)
    const amount = st.payment?.amount ?? computeVendorPricing({ preferred_booth_tier: r.preferred_booth_tier, special_requirements: r.special_requirements }).total
    return { r, st, hist, reviewedMissing, due, amount }
  })
  enriched.sort((a, b) => (b.hist.length - a.hist.length) || (a.due.getTime() - b.due.getTime()))
  const p = enriched[0]
  const priorCount = p.hist.length
  const lastAt = priorCount ? new Date(p.hist[priorCount - 1].at) : null
  const daysRemaining = daysBetween(today, p.due)
  const overdue = p.due < today
  const first = (p.r.contact_name || 'there').trim().split(/\s+/)[0] || 'there'
  const phones = [...new Set(rows.map((r) => e164(r.phone)).filter(Boolean))]
  const emails = [...new Set(rows.map((r) => (r.email || '').trim()).filter(Boolean))]
  return {
    primary: p.r, rows, phones, emails, first,
    biz: (p.r.business_name || '').trim(),
    amount: p.amount, due: p.due, daysRemaining, overdue,
    priorCount, lastAt,
    reviewedMissing: enriched.some((e) => e.reviewedMissing),
    seg: segOf(priorCount),
  }
}

async function main() {
  const today = new Date()
  if (today > FINAL_SETTLEMENT) { console.log('Past final settlement date (31 Aug 2026). Nothing to chase.'); return }

  const url = `${BASE}/rest/v1/vendor_applications?status=eq.approved&select=id,business_name,contact_name,email,phone,admin_notes,reviewed_at,created_at,preferred_booth_tier,special_requirements`
  const all = (await (await fetch(url, { headers: h })).json()) as Row[]

  // Keep approved + unpaid + not a test row.
  const unpaid = all.filter((r) => {
    if (isTestVendor(r)) return false
    const st = parsePortalState(r.admin_notes)
    return !isPaid(st, r)
  })

  // De-dup by real person: union rows that share EITHER a normalized email OR an
  // E.164 phone (Melonscape has two rows, same phone, different emails, so an
  // email-only key would double-message the phone). Union-find over row indices.
  const uf = unpaid.map((_, i) => i)
  const find = (x: number): number => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x] } return x }
  const union = (a: number, b: number) => { uf[find(a)] = find(b) }
  const byEmail = new Map<string, number>()
  const byPhone = new Map<string, number>()
  unpaid.forEach((r, i) => {
    const em = (r.email || '').trim().toLowerCase()
    const ph = e164(r.phone)
    if (em) { if (byEmail.has(em)) union(i, byEmail.get(em)!); else byEmail.set(em, i) }
    if (ph) { if (byPhone.has(ph)) union(i, byPhone.get(ph)!); else byPhone.set(ph, i) }
  })
  const comp = new Map<number, Row[]>()
  unpaid.forEach((r, i) => { const root = find(i); const g = comp.get(root) || []; g.push(r); comp.set(root, g) })

  let targets = [...comp.values()].map((rows) => buildTarget(rows, today))
  if (ONLY) targets = targets.filter((t) => t.biz.toLowerCase() === ONLY)

  // Optional recency floor.
  const skippedRecent: string[] = []
  if (MIN_GAP_DAYS > 0) {
    targets = targets.filter((t) => {
      if (t.lastAt && daysBetween(t.lastAt, today) < MIN_GAP_DAYS) { skippedRecent.push(`${t.biz} (reminded ${daysBetween(t.lastAt, today)}d ago)`); return false }
      return true
    })
  }

  // Stable, useful order: overdue first (most overdue first), then soonest due.
  targets.sort((a, b) => a.daysRemaining - b.daysRemaining)

  const dups = targets.filter((t) => t.rows.length > 1)
  const revMissing = targets.filter((t) => t.reviewedMissing)

  console.log(`\n${DRY ? 'DRY RUN (nothing sent)' : 'LIVE SEND'} — ${targets.length} vendor(s), ${unpaid.length} unpaid rows`)
  if (MIN_GAP_DAYS > 0) console.log(`MIN_GAP_DAYS=${MIN_GAP_DAYS} → skipped ${skippedRecent.length} recently-reminded`)
  console.log('='.repeat(70))

  let waOk = 0, mailOk = 0, recorded = 0
  const fails: string[] = []

  for (const t of targets) {
    const tag = t.overdue ? `OVERDUE ${Math.abs(t.daysRemaining)}d` : `${t.daysRemaining}d left`
    const body = waBody(t)
    console.log(`\n### ${t.biz}  [${t.seg}/${tag}, prior=${t.priorCount}${t.lastAt ? `, last ${fmtDate(t.lastAt)}` : ''}${t.reviewedMissing ? ', reviewed_at MISSING' : ''}${t.rows.length > 1 ? `, ${t.rows.length} rows MERGED` : ''}]`)
    console.log(`  amount ${formatRand(t.amount)}, due ${fmtDate(t.due)}`)
    console.log(`  WA → ${t.phones.join(', ') || '(none)'}: Hi ${t.first}! ${body}`)
    console.log(`  EMAIL → ${t.emails.join(', ') || '(none)'}: "${emailSubject(t)}"`)

    if (DRY) continue

    let sentSomething = false
    // WhatsApp: one per distinct phone.
    if (!t.phones.length) fails.push(`WA ${t.biz}: no phone`)
    for (const phone of t.phones) {
      try {
        const wr = await sendTemplate(phone, 'festival_announcement', [t.first, body], { category: 'utility' })
        if (wr.skipped) fails.push(`WA ${t.biz} (${phone}): skipped ${wr.skipped}`)
        else { waOk++; sentSomething = true; console.log(`  WA sent → ${phone}`) }
      } catch (e) { fails.push(`WA ${t.biz} (${phone}): ${(e as Error).message}`) }
    }

    // Email: one per distinct email.
    if (!t.emails.length) fails.push(`EMAIL ${t.biz}: no email`)
    for (const email of t.emails) {
      try {
        const er = await sendEmail({ to: email, subject: emailSubject(t), react: ReminderEmail(t) })
        if (er.ok) { mailOk++; sentSomething = true; console.log(`  EMAIL sent → ${email}`) } else fails.push(`EMAIL ${t.biz} (${email}): ${er.error}`)
      } catch (e) { fails.push(`EMAIL ${t.biz} (${email}): ${(e as Error).message}`) }
    }

    // Record history ONLY if a channel actually delivered (canary lesson,
    // 2026-07-24: a record with no send makes the cron skip a vendor who got
    // nothing). Append to EVERY row for this person; backfill reviewed_at from
    // created_at where missing so the cron stops skipping them.
    if (!sentSomething) { fails.push(`RECORD ${t.biz}: nothing sent`); continue }
    for (const r of t.rows) {
      const st = parsePortalState(r.admin_notes)
      const prior = historyOf(st)
      const week = Math.min(prior.length + 1, 4)
      const nextState = {
        ...st,
        payment_reminders: {
          ...(((st as unknown) as { payment_reminders?: Record<string, unknown> }).payment_reminders || {}),
          history: [...prior, { at: new Date().toISOString(), week }],
          due_date: t.due.toISOString(),
        },
      }
      const newNotes = updatePortalStateImpl(r.admin_notes || '', nextState as never)
      const patch: Record<string, unknown> = { admin_notes: newNotes }
      if (!r.reviewed_at && r.created_at) patch.reviewed_at = r.created_at
      const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      })
      if (pr.ok) { recorded++ } else fails.push(`RECORD ${t.biz} (${r.id}): ${pr.status} ${await pr.text()}`)
    }
    console.log(`  history recorded (${t.rows.length} row${t.rows.length === 1 ? '' : 's'})`)
    await new Promise((res) => setTimeout(res, 250)) // Law 5 throttle
  }

  // Summary
  const overdueN = targets.filter((t) => t.overdue).length
  const soonN = targets.filter((t) => !t.overdue && t.daysRemaining <= 7).length
  console.log(`\n${'='.repeat(70)}`)
  console.log(`targets: ${targets.length} | overdue: ${overdueN} | soon(<=7d): ${soonN} | duplicates merged: ${dups.length} | reviewed_at backfilled: ${revMissing.length}`)
  if (dups.length) console.log(`  merged dup rows: ${dups.map((d) => d.biz).join(', ')}`)
  if (!DRY) {
    console.log(`WA sent: ${waOk} | email sent: ${mailOk} | history rows recorded: ${recorded}`)
    if (fails.length) { console.log(`\nFAILURES (${fails.length}):`); fails.forEach((f) => console.log(`  - ${f}`)) }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
