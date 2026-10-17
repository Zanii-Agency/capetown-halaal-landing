// BATCH 7 (Taona 2026-10-02): the last 4 master stall payers with extras still owing;
// the plan covers the stall money paid, extras stay a separate balance.
// BATCH 4 (Taona 2026-09-29): 6 more pre-26-Aug ...191 full payers, early Nov to 1 Dec,
// dates distinct from batch 3 and each other. Cloned from batch 3.
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
  { id: '65267bc2-4625-47b4-a815-46d726f99f95', name: "BAGD", total: 6500 },
  { id: 'e3a452b9-8175-401b-825d-cd1dc1cb339f', name: "It\u2019s SnackTime", total: 8500 },
  { id: 'e97febda-27c0-4b5e-b731-71356da086e5', name: "Mias Chill Station", total: 5000 },
  { id: 'fa1c1e2a-21f1-49fe-9b63-74a9b6a4bec7', name: "Prawn Star", total: 4800 },
]

const WINDOW = '2026-11-02..2026-12-01'
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
// Taona 2026-09-28: dates must not line up across vendors. Hand-set, every
// date distinct across the batch; amounts unchanged from the seeded split.
const DATES: Record<string, string[]> = {
  '65267bc2-4625-47b4-a815-46d726f99f95': ['2026-11-03', '2026-11-11', '2026-11-19', '2026-11-28'],
  'e3a452b9-8175-401b-825d-cd1dc1cb339f': ['2026-11-05', '2026-11-13', '2026-11-23', '2026-12-01'],
  'e97febda-27c0-4b5e-b731-71356da086e5': ['2026-11-06', '2026-11-26'],
  'fa1c1e2a-21f1-49fe-9b63-74a9b6a4bec7': ['2026-11-08', '2026-11-24'],
}
const AMOUNTS: Record<string, number[]> = {
  '65267bc2-4625-47b4-a815-46d726f99f95': [1550, 1800, 1700, 1450],
  'e3a452b9-8175-401b-825d-cd1dc1cb339f': [2100, 2300, 1950, 2150],
  'e97febda-27c0-4b5e-b731-71356da086e5': [2400, 2600],
  'fa1c1e2a-21f1-49fe-9b63-74a9b6a4bec7': [2250, 2550],
}
function planFor(row: Row): { date: string; amount: number }[] {
  return DATES[row.id].map((date, i) => ({ date, amount: AMOUNTS[row.id][i] }))
}

const DRY = process.argv.includes('--dry')
const UNDO = process.argv.includes('--undo')
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

async function main() {
  const db = createAdminClient()
  const snapPath = process.env.SNAPSHOT_PATH || path.join(os.tmpdir(), `settlement-batch7-snapshot-${Date.now()}.json`)
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
