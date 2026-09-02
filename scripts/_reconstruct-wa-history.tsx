// Reconstruct WhatsApp chase sends that were never logged.
//
// Background: before logWhatsAppOutbound existed (added 2026-08-01), chase
// scripts and the Monday payment-reminder cron sent WhatsApp templates without
// writing wa_messages rows. The sends happened (each is stamped in the vendor's
// payment_reminders.history) but are invisible in the inbox. Meta has no
// sent-messages API, so the only honest recovery is reconstruction from the
// recorded history + the known campaign copy.
//
// Every inserted row carries metadata.reconstructed=true and NO delivery
// status (no fake ticks). created_at is the real recorded send time from the
// history entry, so the message slots into the thread exactly when it happened.
//
// Copy sources (verified against the repo):
//   - Monday cron days: vendor_payment_reminder template, cron passes
//     [firstName, formatRand(amount), dueDateStr] (cron/payment-reminders/route.ts)
//   - 2026-07-25 batches: exact per-vendor `wa` text from scripts/chase-copy/*.json
//   - 2026-07-29: waBody from scripts/_chase-overdue-2026-07-29.tsx
//   - 2026-07-31: default waBody from scripts/chase-overdue-unpaid-custom.tsx
//
// Idempotent: skips a (phone, day, template) that already has a template row
// OR an existing reconstructed row. DRY by default; SEND=1 to write.
//
//   node --import tsx scripts/_reconstruct-wa-history.tsx          # dry run
//   SEND=1 node --import tsx scripts/_reconstruct-wa-history.tsx   # write

import { config } from 'dotenv'
config({ path: '.env.local' })
import { readFileSync } from 'fs'
import { parsePortalState } from '../src/lib/portal-state'
import { computeVendorPricing, formatRand } from '../src/lib/payments/pricing'
import { computePaymentDue, fmtDate } from '../src/lib/exhibitor-paygate'

const DRY = process.env.SEND !== '1'
const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const PORTAL_URL = 'https://cthalaal.co.za/exhibitor/portal/payments'

const CRON_DAYS = new Set(['2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'])
const BATCH_COPY_DAY = '2026-07-25'
const JUL29_DAY = '2026-07-29'
const JUL31_DAY = '2026-07-31'

// Exact per-vendor WA copy for the 25 July batches.
const batchCopy = new Map<string, string>()
for (const f of ['batch-1.json', 'batch-2.json', 'batch-3.json']) {
  try {
    const arr = JSON.parse(readFileSync(`${__dirname}/chase-copy/${f}`, 'utf8')) as Array<{ key: string; wa: string }>
    for (const e of arr) batchCopy.set((e.key || '').trim().toLowerCase(), e.wa)
  } catch (e) { console.error(`copy file ${f} unreadable:`, (e as Error).message) }
}
console.log(`batch copy loaded for ${batchCopy.size} vendors`)

type VRow = {
  id: string; business_name: string | null; contact_name: string | null
  phone: string | null; admin_notes: string | null
  preferred_booth_tier: string | null; special_requirements: unknown
  reviewed_at: string | null; payment_due_date: string | null
}

function e164(p?: string | null): string {
  if (!p) return ''
  let digits = (p || '').replace(/\D/g, '')
  if (digits.length === 9 && !digits.startsWith('0')) digits = '0' + digits
  if (digits.startsWith('0')) digits = '27' + digits.slice(1)
  if (!/^27\d{9}$/.test(digits)) return ''
  return digits // no '+', matching logWhatsAppOutbound's storage form
}

// Days overdue exactly as the chase scripts computed it at send time:
// daysUntil = ceil((due - now)/day), and the history entry's `at` IS that now.
function overAt(due: Date, at: string): number {
  return -Math.ceil((due.getTime() - new Date(at).getTime()) / 86400000)
}

function bodyFor(day: string, at: string, first: string, biz: string, amount: number, due: Date | null): { body: string; template: string } | null {
  const dueStr = due ? fmtDate(due) : 'TBC'
  if (CRON_DAYS.has(day)) {
    return {
      template: 'vendor_payment_reminder',
      body: `Hi ${first}, this is a friendly reminder that your stall fee of ${formatRand(amount)} is due on ${dueStr}. Reply here if you need the payment link again.`,
    }
  }
  if (day === BATCH_COPY_DAY) {
    const wa = batchCopy.get(biz.trim().toLowerCase())
    if (!wa) return null // report as unmatched; do not invent copy
    return { template: 'festival_announcement', body: `Hi ${first}!\n\n${wa}` }
  }
  if (day === JUL29_DAY) {
    if (!due) return null
    const over = Math.max(1, overAt(due, at))
    return {
      template: 'festival_announcement',
      body: `Hi ${first}!\n\nYour stall fee of ${formatRand(amount)} for the Young at Heart Festival was due on ${dueStr}, so it is now ${over} day${over === 1 ? '' : 's'} overdue. Please log in to your exhibitor portal and complete your payment today: ${PORTAL_URL}. Your stall is only secured once payment is received in full.`,
    }
  }
  if (day === JUL31_DAY) {
    const over = due ? overAt(due, at) : 0
    const overdueText = over > 0 ? `is now ${over} day${over === 1 ? '' : 's'} overdue` : `is due on ${dueStr}`
    return {
      template: 'festival_announcement',
      body: `Hi ${first}!\n\nYour stall fee of ${formatRand(amount)} for the Young at Heart Festival ${overdueText}. Please log in to your exhibitor portal and complete your payment today: ${PORTAL_URL}. Your stall is only secured once payment is received in full.`,
    }
  }
  return null
}

async function main() {
  // Existing outbound template/reconstructed rows, 60 days back.
  const since = new Date(Date.now() - 60 * 86400000).toISOString()
  const have = new Set<string>()
  for (let page = 0; ; page++) {
    const r = await fetch(`${BASE}/rest/v1/wa_messages?direction=eq.out&created_at=gte.${since}&select=wa_phone,template_name,metadata,created_at&order=id&limit=1000&offset=${page * 1000}`, { headers: h })
    const rows = await r.json()
    if (!Array.isArray(rows) || !rows.length) break
    for (const m of rows as Array<{ wa_phone: string; template_name: string | null; metadata: Record<string, unknown> | null; created_at: string }>) {
      const k9 = (m.wa_phone || '').replace(/\D/g, '').slice(-9)
      const day = (m.created_at || '').slice(0, 10)
      const tpl = m.template_name || (m.metadata as { template?: string } | null)?.template || ''
      if (tpl) have.add(`${k9}|${day}|${tpl}`)
      if (m.metadata && (m.metadata as { reconstructed?: boolean }).reconstructed) have.add(`${k9}|${day}|RECON`)
    }
    if (rows.length < 1000) break
  }
  console.log(`existing template/recon day keys: ${have.size}`)

  const vr = await fetch(`${BASE}/rest/v1/vendor_applications?status=eq.approved&select=id,business_name,contact_name,phone,admin_notes,preferred_booth_tier,special_requirements,reviewed_at,payment_due_date&limit=1000`, { headers: h })
  const vendors = (await vr.json()) as VRow[]

  let inserted = 0, skippedExisting = 0, unmatchedCopy = 0, noPhone = 0, wrongDay = 0
  const seen = new Set<string>()
  const unmatched: string[] = []
  const wrongDays: Record<string, number> = {}

  for (const v of vendors) {
    const phone = e164(v.phone)
    const k9 = phone.slice(-9)
    const st = parsePortalState(v.admin_notes)
    const hist = ((st as unknown as { payment_reminders?: { history?: Array<{ at: string }> } }).payment_reminders?.history) || []
    if (!hist.length) continue
    const first = (v.contact_name || 'there').trim().split(/\s+/)[0] || 'there'
    const biz = (v.business_name || '').trim()
    const amount = (st.payment?.amount as number | undefined) ?? computeVendorPricing({ preferred_booth_tier: v.preferred_booth_tier, special_requirements: v.special_requirements }).total
    // Prefer the computed due date; fall back to the due date the chase itself
    // recorded in payment_reminders.due_date (some rows lack reviewed_at AND
    // the notified marker, so computePaymentDue returns null for them).
    const recordedDue = ((st as unknown as { payment_reminders?: { due_date?: string } }).payment_reminders?.due_date)
    const due = computePaymentDue(v) || (recordedDue ? new Date(recordedDue) : null)

    for (const entry of hist) {
      const day = (entry.at || '').slice(0, 10)
      if (!day) continue
      if (!phone) { noPhone++; continue }
      const spec = bodyFor(day, entry.at, first, biz, amount, due)
      if (!spec) {
        if (day === BATCH_COPY_DAY) { unmatchedCopy++; if (!unmatched.includes(biz)) unmatched.push(biz) }
        else { wrongDay++; wrongDays[day] = (wrongDays[day] || 0) + 1 }
        continue
      }
      const dedupeKey = `${k9}|${day}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      if (have.has(`${k9}|${day}|${spec.template}`) || have.has(`${k9}|${day}|RECON`)) { skippedExisting++; continue }

      const row = {
        direction: 'out',
        wa_phone: phone,
        body: spec.body,
        template_name: spec.template,
        status: null,
        provider_message_id: null,
        metadata: {
          reconstructed: true,
          template: spec.template,
          campaign_day: day,
          note: 'send recorded in reminder history but never logged; reconstructed 2026-08-01',
        },
        created_at: entry.at,
      }
      if (DRY) {
        if (inserted < 6) console.log(`\n--- [${day}] ${biz} -> ${phone}\n${row.body}`)
        inserted++; continue
      }
      const pr = await fetch(`${BASE}/rest/v1/wa_messages`, {
        method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(row),
      })
      if (pr.ok) inserted++
      else console.error('insert failed', biz, day, pr.status, (await pr.text()).slice(0, 160))
    }
  }

  console.log(`\n${DRY ? 'DRY RUN' : 'WRITE'} — reconstructed rows ${DRY ? 'to insert' : 'inserted'}: ${inserted}`)
  console.log(`  skipped (real row already exists): ${skippedExisting}`)
  console.log(`  skipped (no valid phone): ${noPhone}`)
  console.log(`  skipped (25 Jul vendor not in copy files): ${unmatchedCopy}${unmatched.length ? ` -> ${unmatched.join(', ')}` : ''}`)
  console.log(`  skipped (unmapped campaign day): ${wrongDay}`)
  if (wrongDay) console.log(`  unmapped days: ${JSON.stringify(wrongDays)}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
