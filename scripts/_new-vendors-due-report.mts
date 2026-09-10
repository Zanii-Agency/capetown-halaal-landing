// READ-ONLY report: the NEWVENDOR cohort (flipped freshers on master EFT), who is
// DUE and their payment dates. No writes, no sends. Mirrors /admin/new-vendors'
// cohort + status, adds the due date (payment.due override else reviewed_at+30).
//   npx tsx --env-file=.env.local scripts/_new-vendors-due-report.mts
import { createAdminClient } from '@/lib/supabase/admin'
import { hasNewVendorMarker } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { vendorBill } from '@/lib/payments/vendor-bill'
import { computePaymentDue, fmtDate } from '@/lib/exhibitor-paygate'
import { writeFileSync } from 'node:fs'

const TODAY = new Date('2026-09-10T00:00:00+02:00') // festival TZ (SAST)

const db = createAdminClient()
const { data, error } = await db
  .from('vendor_applications')
  .select('id, business_name, contact_name, phone, email, admin_notes, paid_at, preferred_booth_tier, special_requirements, created_at, reviewed_at, is_duplicate, status')
  .eq('status', 'approved')
if (error) { console.error(error); process.exit(1) }

type Row = {
  name: string; phone: string | null; status: string
  owed: number; billed: number; dueIso: string | null; dueLabel: string
  overdueDays: number | null; settled: boolean
}
const rows: Row[] = []
for (const v of data || []) {
  if ((v as any).is_duplicate) continue
  if (!hasNewVendorMarker(v.admin_notes as string | null)) continue
  const p = parsePortalState(v.admin_notes as string).payment
  let status = 'Not started'
  if (v.paid_at || p?.status === 'paid') status = 'Paid'
  else if (p?.status === 'collected' || p?.eft_collected_at) status = 'Collected'
  else if (p?.eft_submitted_at) status = 'Proof uploaded'
  else if (p?.eft_revealed_at) status = 'Opened EFT'

  let owed = 0, billed = 0, settled = false
  try {
    const b = vendorBill({
      id: v.id as string,
      preferred_booth_tier: v.preferred_booth_tier as string,
      special_requirements: v.special_requirements,
      admin_notes: v.admin_notes as string,
      paid_at: v.paid_at as string | null,
    })
    owed = b.owing; billed = b.liveTotal; settled = b.settled
  } catch { /* unpriceable */ }

  // Due date: explicit plan/extension marker (payment.due) wins, else reviewed_at + 30.
  const planDue = p?.due ? new Date(p.due) : null
  const due = planDue && !isNaN(planDue.getTime())
    ? planDue
    : computePaymentDue({ reviewed_at: v.reviewed_at as string | null })
  const dueIso = due ? due.toISOString() : null
  const overdueDays = due ? Math.round((TODAY.getTime() - due.getTime()) / 86400000) : null

  rows.push({
    name: (v.business_name as string) || (v.contact_name as string) || 'Unnamed',
    phone: (v.phone as string) || null,
    status, owed, billed, dueIso,
    dueLabel: fmtDate(due, 'no date'),
    overdueDays, settled,
  })
}

// Sort: most overdue first, then by name.
rows.sort((a, b) => (b.overdueDays ?? -1e9) - (a.overdueDays ?? -1e9) || a.name.localeCompare(b.name))

const unpaid = rows.filter(r => !r.settled && r.owed > 0)
const dueNow = unpaid.filter(r => (r.overdueDays ?? -999) >= 0) // due date reached / passed
const upcoming = unpaid.filter(r => (r.overdueDays ?? -999) < 0)
const settledRows = rows.filter(r => r.settled || r.owed <= 0)

const R = (n: number) => 'R' + n.toLocaleString('en-ZA')
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s).padEnd(n)

console.log(`\n=== NEW-VENDOR COHORT (flipped freshers) — ${rows.length} vendors — as at 10 Sep 2026 ===\n`)
console.log(`DUE NOW (owe money, due date reached/passed): ${dueNow.length}`)
console.log(`UPCOMING (owe money, due date still ahead):    ${upcoming.length}`)
console.log(`SETTLED / nothing owing:                       ${settledRows.length}`)
console.log(`Total still owed by the cohort:                ${R(unpaid.reduce((s, r) => s + r.owed, 0))}\n`)

const show = (title: string, list: Row[]) => {
  if (!list.length) return
  console.log(`\n--- ${title} (${list.length}) ---`)
  console.log(pad('Business', 30) + pad('Phone', 15) + pad('Status', 15) + pad('Owed', 11) + pad('Due date', 16) + 'Overdue')
  for (const r of list) {
    const od = r.overdueDays == null ? '—' : r.overdueDays > 0 ? `${r.overdueDays}d ago` : r.overdueDays === 0 ? 'today' : `in ${-r.overdueDays}d`
    console.log(pad(r.name, 30) + pad(r.phone || '—', 15) + pad(r.status, 15) + pad(R(r.owed), 11) + pad(r.dueLabel, 16) + od)
  }
}
show('DUE NOW', dueNow)
show('UPCOMING', upcoming)
show('SETTLED / nothing owing', settledRows)

writeFileSync('scratchpad/new-vendors-due.json', JSON.stringify({ generatedAt: new Date().toISOString(), counts: { total: rows.length, dueNow: dueNow.length, upcoming: upcoming.length, settled: settledRows.length }, rows }, null, 2))
console.log('\nJSON -> scratchpad/new-vendors-due.json')
