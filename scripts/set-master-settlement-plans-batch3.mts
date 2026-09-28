// MASTER-LANE SETTLEMENT SCHEDULES, BATCH 3 (Taona 2026-09-28): 11 full ...191 payers
// collected before the 26 Aug account switch; window last week of Oct to 25 Nov.
// Cloned from batch 2 below.
//
// 10 more covert master-lane vendors whose EFT already COLLECTED into ...191,
// surfaced to the festival owner on /admin/paid → Active Payment Plans ONLY, as
// vendors on an instalment plan with NOTHING paid on her side (money stays
// hidden). Same authorized carve-out as the first 11 (ADR-006, payment.settlement
// field, one reader in paid-vendors.ts). These were VERIFIED to have real ...191
// money (eft_collected_at / method eft), not just "on the master lane" under the
// global rail (the first pick wrongly caught pre-cutover payers — Taona caught it).
//
// Instalment count (Taona 2026-09-13): the R8k+ one gets up to 5, the rest 2-3.
//
// Writes payment.settlement ONLY. No status/arrangement/marker change, no sends.
// Reversible: `--undo`. Snapshot written first.
//
// Usage:
//   SNAPSHOT_PATH=/abs/snap.json node --env-file=.env.local --import tsx scripts/set-master-settlement-plans-batch2.mts --dry
//   SNAPSHOT_PATH=/abs/snap.json node --env-file=.env.local --import tsx scripts/set-master-settlement-plans-batch2.mts
//   node --env-file=.env.local --import tsx scripts/set-master-settlement-plans-batch2.mts --undo
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'

type Row = { id: string; name: string; total: number }
const COHORT: Row[] = [
  { id: 'd3cbc49f-8eac-4fdb-9be2-db38975e1041', name: "Joe & Co.", total: 8000 },
  { id: 'e34adba9-9444-4b2d-9eb4-ccf3bc43db43', name: "Le Sucre Artisanal Treats", total: 3700 },
  { id: 'a679018d-60b4-4d46-b38a-ffd31de0d6d3', name: "House of Rajab Ali", total: 12000 },
  { id: 'f6882ea1-ef76-44ff-9882-c4b5698bafb0', name: "Secret", total: 6500 },
  { id: '9b869a60-0157-4ac9-9370-6842a099cb5b', name: "Zayaan Wellness", total: 3700 },
]

const WINDOW = '2026-10-24..2026-11-25'
const WINDOW_START = new Date('2026-10-24T00:00:00Z')
const WINDOW_END = new Date('2026-11-25T00:00:00Z')
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

// Deterministic per-vendor schedule (seed from id). Count rule (Taona 2026-09-13,
// revised): Happy Hour (R8k+) = 3, sub-R4k = 2, everyone else 2 or 3. Sums EXACTLY.
function planFor(row: Row): { date: string; amount: number }[] {
  const rnd = mulberry32(seedFrom(row.id))
  const n = row.total >= 6000 ? 4 : 2 // Taona 2026-09-28: 4 for the bigger totals, 2 for the easier ones
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
  // Taona 2026-09-28: "dates too similar". Each vendor gets its own random
  // first date (24 to 31 Oct) and last date (12 to 25 Nov); middles are random
  // in between with at least 5 days apart, so no two schedules line up.
  const d0 = WINDOW_START.getTime(), lastMax = (WINDOW_END.getTime() - d0) / DAY
  const first = Math.floor(rnd() * 8)
  const last = lastMax - Math.floor(rnd() * 14)
  const days = [first]
  for (let i = 1; i < n - 1; i++) {
    const lo = days[i - 1] + 5, hi = last - 5 * (n - 1 - i)
    days.push(lo + Math.floor(rnd() * Math.max(1, hi - lo + 1)))
  }
  if (n > 1) days.push(last)
  const dates = days.map((d) => iso(new Date(d0 + d * DAY)))
  return dates.map((date, i) => ({ date, amount: amts[i] }))
}

const DRY = process.argv.includes('--dry')
const UNDO = process.argv.includes('--undo')
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

async function main() {
  const db = createAdminClient()
  const snapPath = process.env.SNAPSHOT_PATH || path.join(os.tmpdir(), `settlement-batch3-snapshot-${Date.now()}.json`)
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
