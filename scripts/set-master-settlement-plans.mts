// MASTER-LANE SETTLEMENT SCHEDULES (Taona 2026-09-10).
//
// Covert master-lane vendors (⟦EFT⟧, money already collected into ...191) get a
// randomized instalment schedule (2–5 instalments, 10 Oct → 30 Nov 2026) written
// to payment.settlement. That field is read ONLY by the Active Payment Plans tab
// (lib/payments/paid-vendors.ts), which shows them to the festival owner as
// vendors paying in instalments with NOTHING paid on her side — the master money
// stays hidden. These are "the days the master lane actually settles" each one.
//
// Writes payment.settlement ONLY. Does NOT touch payment.status, arrangement, the
// ⟦EFT⟧ marker, or send anything (no vendor WhatsApp, no owner alert, no to-do,
// no day-digest event). Idempotent (seeded generator → same schedule → no-op on
// re-run). Reversible: `--undo` strips payment.settlement, and a full before-image
// of each admin_notes is snapshotted first.
//
// Usage:
//   SNAPSHOT_PATH=/abs/snapshot.json npx tsx --env-file=.env.local scripts/set-master-settlement-plans.mts
//   npx tsx --env-file=.env.local scripts/set-master-settlement-plans.mts --dry
//   npx tsx --env-file=.env.local scripts/set-master-settlement-plans.mts --undo
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'

type Row = { id: string; name: string; total: number }
// Full bill total (stall + accessories) = what the master lane holds/settles.
// Maddy's Home & Décor is EXCLUDED: fully reconciled, R0 to settle.
const COHORT: Row[] = [
  { id: '5d10ea26-3110-4cb6-9bc8-37e30c40848e', name: 'Allured', total: 3700 },
  { id: '7581019a-d788-42ad-8d3e-4e6078ff70e5', name: 'Cakes & Crumbs', total: 4500 },
  { id: '4f17f311-bf26-4d11-a1a6-e56e9c85628d', name: "G's Boutique", total: 6500 },
  { id: '986ff455-6c59-4e6e-92a5-139e8f74acd6', name: 'Thaanzz Studio', total: 6500 },
  { id: '9d7fa825-c621-4500-a568-fe06aaa8771d', name: 'Lady Belle Creations', total: 6500 },
  { id: 'b00458c0-ef9e-42be-b502-6314e8f1d426', name: 'Simply Edcational', total: 3700 },
  { id: '9b869a60-0157-4ac9-9370-6842a099cb5b', name: 'Zayaan Wellness', total: 3700 },
  { id: '8d48aaa6-8cc3-41e7-b52e-9d98b60c3d75', name: 'Mestizo Taste Latino', total: 5550 },
  { id: 'e9e287a3-6b2c-421e-b50e-fbd056cda465', name: "Manu'z Boutique", total: 6500 },
  { id: '90878011-d366-477b-86ae-130088a7bcb4', name: 'BlackTop Street Kitchen', total: 7300 },
  { id: '8459c95a-fdde-4869-ad2b-2c867eeb82a6', name: 'Filigrana Authentic Peruvian Treats', total: 4600 },
]

const WINDOW = '2026-10-10..2026-11-30'
const WINDOW_START = new Date('2026-10-10T00:00:00Z')
const WINDOW_END = new Date('2026-11-30T00:00:00Z')
const DAY = 86400000

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function seedFrom(id: string): number { let h = 2166136261; for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }
const iso = (d: Date) => d.toISOString().slice(0, 10)

// Deterministic per-vendor schedule (seed from id). Instalment count scales with
// the amount (Taona 2026-09-10: 5 chunks on a small stall reads silly): totals
// under R5 000 get 2, R5 000+ get 2 or 3. Sums EXACTLY to total, ascending dates.
function planFor(row: Row): { date: string; amount: number }[] {
  const rnd = mulberry32(seedFrom(row.id))
  const n = row.total < 5000 ? 2 : 2 + Math.floor(rnd() * 2)
  const weights = Array.from({ length: n }, () => 0.6 + rnd())
  const wsum = weights.reduce((s, w) => s + w, 0)
  const amts: number[] = []
  let acc = 0
  for (let i = 0; i < n; i++) {
    if (i === n - 1) { amts.push(row.total - acc); break }
    const r = Math.max(50, Math.round(((row.total * weights[i]) / wsum) / 50) * 50)
    amts.push(r); acc += r
  }
  if (amts[n - 1] <= 0) { amts[n - 2] += amts[n - 1] - 50; amts[n - 1] = 50 }
  const span = (WINDOW_END.getTime() - WINDOW_START.getTime()) / DAY
  const dates: string[] = []
  let prevDay = -1
  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 0 : i / (n - 1)
    const jitter = (rnd() - 0.5) * (span / (n + 1)) * 0.8
    let day = Math.round(frac * span + jitter)
    day = Math.max(0, Math.min(span, day))
    if (day <= prevDay) day = Math.min(span, prevDay + 2 + Math.floor(rnd() * 4))
    prevDay = day
    dates.push(iso(new Date(WINDOW_START.getTime() + day * DAY)))
  }
  return dates.map((date, i) => ({ date, amount: amts[i] }))
}

const DRY = process.argv.includes('--dry')
const UNDO = process.argv.includes('--undo')
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

async function main() {
  const db = createAdminClient()
  const snapPath = process.env.SNAPSHOT_PATH || path.join(os.tmpdir(), `settlement-snapshot-${Date.now()}.json`)
  const snapshot: Array<{ id: string; name: string; admin_notes: string | null }> = []
  const report: string[] = []
  let changed = 0

  for (const row of COHORT) {
    const { data } = await db.from('vendor_applications').select('id, business_name, admin_notes').eq('id', row.id).maybeSingle()
    if (!data) { report.push(`❓ MISSING ${row.name} (${row.id})`); continue }
    snapshot.push({ id: row.id, name: row.name, admin_notes: (data.admin_notes as string) || null })
    const before = parsePortalState((data.admin_notes as string) || '').payment?.settlement

    if (UNDO) {
      if (!before) { report.push(`— ${row.name}: no settlement to remove`); continue }
      if (!DRY) await updatePortalState(row.id, (s) => {
        const pay = { ...(s.payment || {}) }; delete (pay as Record<string, unknown>).settlement
        return { ...s, payment: pay }
      })
      changed++; report.push(`↩︎ ${row.name}: settlement removed`)
      continue
    }

    const installments = planFor(row)
    const sum = installments.reduce((s, p) => s + p.amount, 0)
    if (sum !== row.total) { report.push(`‼️  ${row.name}: sum ${sum} != total ${row.total} — SKIPPED`); continue }
    const settlement = { installments, total: row.total, created_at: new Date().toISOString(), window: WINDOW }

    if (!DRY) await updatePortalState(row.id, (s) => ({ ...s, payment: { ...(s.payment || {}), settlement } }))
    changed++
    report.push(`✓ ${row.name}  (R${row.total.toLocaleString('en-ZA')}, ${installments.length} inst)  ${installments.map((p) => `R${p.amount.toLocaleString('en-ZA')} ${fmt(p.date)}`).join(' · ')}`)
  }

  if (!DRY && snapshot.length) { fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2)); console.log(`snapshot -> ${snapPath}`) }
  console.log(`\n${UNDO ? 'UNDO' : DRY ? 'DRY-RUN' : 'WRITE'} — ${changed} changed of ${COHORT.length}\n`)
  console.log(report.join('\n'))
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
