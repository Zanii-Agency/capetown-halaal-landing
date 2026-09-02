#!/usr/bin/env node
// Read-only: approved+unpaid vendors who are overdue or about-to-be-overdue
// AND have no payment-reminder on record. Mirrors the payment-reminders cron
// logic (due = reviewed_at + 30d; reminded = portal_state.payment_reminders.history).
// Cross-checks mail_messages/wa_messages for any manual chase comms.

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const envPath = path.join(repo, '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/i)
  if (!m) continue
  let v = m[2].trim().replace(/^["']|["']$/g, '')
  if (!process.env[m[1]]) process.env[m[1]] = v
}

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
async function rest(path) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

const SOON_DAYS = 7 // "about to be overdue" = due within this many days
const today = new Date()
const daysBetween = (a, b) => Math.floor((b - a) / 86400000)

const PORTAL_RE = /⟦PORTAL:([A-Za-z0-9+/=]+)⟧/
function parseState(notes) {
  const m = String(notes || '').match(PORTAL_RE)
  if (!m) return {}
  try { return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) } catch { return {} }
}

const apps = await rest('vendor_applications?status=eq.approved&select=id,business_name,contact_name,email,phone,admin_notes,status,reviewed_at')

// Any OTHER outbound comms (manual chase / other flows) as a safety net.
// mail_messages keys by vendor_application_id; wa_messages keys by wa_phone.
// NOTE: the payment-reminders cron does NOT log here (it records only to
// portal_state), so these are non-cron touches.
const norm = (p) => String(p || '').replace(/[^0-9]/g, '').replace(/^0/, '27')
const mailedApp = new Set()
const waPhones = new Set()
try {
  for (const r of await rest('mail_messages?direction=eq.out&select=vendor_application_id'))
    if (r.vendor_application_id) mailedApp.add(r.vendor_application_id)
} catch (e) { console.warn(`skip mail_messages: ${e.message.slice(0,80)}`) }
try {
  for (const r of await rest('wa_messages?direction=eq.out&select=wa_phone'))
    if (r.wa_phone) waPhones.add(norm(r.wa_phone))
} catch (e) { console.warn(`skip wa_messages: ${e.message.slice(0,80)}`) }

const rows = []
let cPaid = 0, cReminded = 0, cUnpaid = 0
for (const a of apps) {
  const st = parseState(a.admin_notes)
  const paid = st.payment?.status === 'paid' || st.payment?.status === 'waived'
  if (paid) { cPaid++; continue }
  cUnpaid++
  if ((st.payment_reminders?.history || []).length) cReminded++

  const reviewedAt = a.reviewed_at ? new Date(a.reviewed_at) : null
  const history = st.payment_reminders?.history || []
  const remindedCount = history.length

  let dueDate = null, daysRemaining = null
  if (reviewedAt) {
    dueDate = new Date(reviewedAt); dueDate.setDate(dueDate.getDate() + 30)
    daysRemaining = daysBetween(today, dueDate)
  }

  // classify due-ness
  const overdue = daysRemaining !== null && daysRemaining < 0
  const soon = daysRemaining !== null && daysRemaining >= 0 && daysRemaining <= SOON_DAYS
  const noReviewDate = reviewedAt === null // cron skips these entirely -> never auto-reminded

  // Full gap = any unpaid approved vendor the cron has never reminded.
  const needsFollowup = remindedCount === 0

  if (!needsFollowup) continue
  void overdue; void soon; void noReviewDate
  rows.push({
    business: a.business_name || '(no name)',
    contact: a.contact_name || '',
    due: dueDate ? dueDate.toISOString().slice(0, 10) : 'NO reviewed_at',
    daysRemaining,
    daysSinceApproval: reviewedAt ? daysBetween(reviewedAt, today) : null,
    state: daysRemaining === null ? 'NO reviewed_at (cron skips!)' : daysRemaining < 0 ? `${-daysRemaining}d OVERDUE` : `due in ${daysRemaining}d`,
    email: a.email || '—',
    phone: a.phone || '—',
    hasEmail: !!a.email,
    hasPhone: !!a.phone,
    otherComms: (mailedApp.has(a.id) ? 1 : 0) + (waPhones.has(norm(a.phone)) ? 1 : 0),
    id: a.id,
  })
}

rows.sort((x, y) => (x.daysRemaining ?? 9999) - (y.daysRemaining ?? 9999))

console.log(`\nApproved & unpaid, overdue/soon, NO payment reminder on record: ${rows.length}\n`)
for (const r of rows) {
  const appr = r.daysSinceApproval === null ? '' : `  (approved ${r.daysSinceApproval}d ago)`
  console.log(
    `• ${r.business}  [${r.state}] due ${r.due}${appr}\n` +
    `    contact: ${r.contact}  email: ${r.email}${r.hasEmail ? '' : ' (MISSING)'}  phone: ${r.phone}${r.hasPhone ? '' : ' (MISSING)'}` +
    `${r.otherComms ? `  | ${r.otherComms} other outbound touch(es)` : '  | no other comms'}`
  )
}
console.log(`\n--- diagnostics ---`)
console.log(`approved: ${apps.length} | paid/waived: ${cPaid} | unpaid: ${cUnpaid} | unpaid-with-cron-reminder: ${cReminded}`)
