// BATCH 5 (Taona 2026-09-30): the RECENT master payers plus 4 more, starting
// mid-October. 10 vendors: the 6 Sep FNB payers with master-stamped proofs
// (Fareed Essence, Bag Boutique, Brownie Babe, RaaRaa Studio, Suade Collections,
// Sprinkle Syndicate) + 4 Jul/Aug payers (BAGD, Bes-Teas 3 Aug; Barfi Bliss, Punch'D
// 2 Aug). EVERY one verified paid into ...191 by reading the proof slip itself
// (Sprinkle via Taona's ...191 statement). Baitul Hikmah + Dailyfresh dropped: no proof
// anywhere, account unverifiable. Taona trimmed 8 older ones the same
// day ("just the recent paid ones and maybe 4 more"). Dates distinct, 15 Oct..26 Nov.
// Rule: under R5,000 = 2 instalments, R5,000+ = 3.
// Cloned from batch 4 below.
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
  { id: '54e29439-dff0-48c5-8002-9abd1247a7f3', name: "Bes-Teas Bubble Tea", total: 6500 },
  { id: '65267bc2-4625-47b4-a815-46d726f99f95', name: "BAGD", total: 6500 },
  { id: 'ce713fd2-8690-445a-b9cf-a163a8489e5a', name: "Fareed Essence", total: 3700 },
  { id: '68bf3caa-2add-4566-8556-e0422567f9ad', name: "Bag Boutique", total: 3700 },
  { id: 'ad086831-12fb-475e-bbdc-85b969356544', name: "Brownie Babe", total: 3700 },
  { id: '3bc78400-7629-4053-8336-888be6cb1b8e', name: "RaaRaa Studio", total: 3700 },
  { id: '5aa7b2ff-8cab-4386-ad43-827b96ecc83e', name: "Suade Collections", total: 6500 },
  { id: '657b7cfe-16fa-4a63-90d1-52d3cac15f8e', name: "Sprinkle Syndicate", total: 5000 },
  { id: 'f3e21663-37ac-463b-9217-6e13793bf099', name: "Barfi Bliss", total: 6500 },
  { id: 'e3b885e0-4edf-49d7-bf90-437af2a82834', name: "Punch'D", total: 3700 },
]

const WINDOW = '2026-10-15..2026-11-27'
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
  'e3b885e0-4edf-49d7-bf90-437af2a82834': ['2026-10-17', '2026-11-16'], // Punch'D
  'f3e21663-37ac-463b-9217-6e13793bf099': ['2026-10-15', '2026-11-06', '2026-11-12'], // Barfi Bliss
  '54e29439-dff0-48c5-8002-9abd1247a7f3': ['2026-10-26', '2026-11-05', '2026-11-15'], // Bes-Teas Bubble Tea
  '65267bc2-4625-47b4-a815-46d726f99f95': ['2026-10-29', '2026-11-07', '2026-11-19'], // BAGD
  'ce713fd2-8690-445a-b9cf-a163a8489e5a': ['2026-10-25', '2026-11-26'], // Fareed Essence
  '68bf3caa-2add-4566-8556-e0422567f9ad': ['2026-10-18', '2026-11-24'], // Bag Boutique
  'ad086831-12fb-475e-bbdc-85b969356544': ['2026-10-31', '2026-11-23'], // Brownie Babe
  '3bc78400-7629-4053-8336-888be6cb1b8e': ['2026-10-22', '2026-11-25'], // RaaRaa Studio
  '5aa7b2ff-8cab-4386-ad43-827b96ecc83e': ['2026-10-21', '2026-11-08', '2026-11-22'], // Suade Collections
  '657b7cfe-16fa-4a63-90d1-52d3cac15f8e': ['2026-10-24', '2026-11-02', '2026-11-17'], // Sprinkle Syndicate
}
const AMOUNTS: Record<string, number[]> = {
  'e3b885e0-4edf-49d7-bf90-437af2a82834': [1800, 1900],
  'f3e21663-37ac-463b-9217-6e13793bf099': [2300, 1950, 2250],
  '54e29439-dff0-48c5-8002-9abd1247a7f3': [2200, 2450, 1850],
  '65267bc2-4625-47b4-a815-46d726f99f95': [2100, 2150, 2250],
  'ce713fd2-8690-445a-b9cf-a163a8489e5a': [1650, 2050],
  '68bf3caa-2add-4566-8556-e0422567f9ad': [1650, 2050],
  'ad086831-12fb-475e-bbdc-85b969356544': [1750, 1950],
  '3bc78400-7629-4053-8336-888be6cb1b8e': [2050, 1650],
  '5aa7b2ff-8cab-4386-ad43-827b96ecc83e': [1900, 2150, 2450],
  '657b7cfe-16fa-4a63-90d1-52d3cac15f8e': [1600, 1850, 1550],
}
function planFor(row: Row): { date: string; amount: number }[] {
  return DATES[row.id].map((date, i) => ({ date, amount: AMOUNTS[row.id][i] }))
}

const DRY = process.argv.includes('--dry')
const UNDO = process.argv.includes('--undo')
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

async function main() {
  const db = createAdminClient()
  const snapPath = process.env.SNAPSHOT_PATH || path.join(os.tmpdir(), `settlement-batch5-snapshot-${Date.now()}.json`)
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
