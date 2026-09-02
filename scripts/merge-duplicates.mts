// Merge duplicate vendor applications.
//
//   node --import tsx --env-file=.env.local scripts/merge-duplicates.mts          # dry run
//   node --import tsx --env-file=.env.local scripts/merge-duplicates.mts --apply  # write
//
// Rule (Taona 2026-07-26): "merge all duplicates that are approved, but the
// approved one becomes main contact details and duplicate becomes sub and we
// never use it."
//
// Only clusters containing exactly ONE approved application are touched. The
// approved row is the primary; every other row in the cluster gets a
// ⟦MERGED:<primary-id>⟧ marker and is skipped by every lookup. Rows are never
// deleted: a merged application stays recoverable and is still the evidence
// that this person applied twice.
//
// Clusters with no approved member (pending/rejected pairs) are LEFT ALONE by
// design — picking a winner between two pending applications is a judgement
// call, not a rule.
import { createAdminClient } from '@/lib/supabase/admin'
import { emailKey, isMerged, withMergedMarker } from '@/lib/merge'

const APPLY = process.argv.includes('--apply')
const db = createAdminClient()

const { data, error } = await db
  .from('vendor_applications')
  .select('id, business_name, email, status, paid_at, admin_notes, created_at')
if (error) throw error
const all = data || []

const clusters = new Map<string, typeof all>()
for (const r of all) {
  const k = emailKey(r.email)
  if (!k) continue
  if (!clusters.has(k)) clusters.set(k, [] as never)
  clusters.get(k)!.push(r)
}

let planned = 0, skipped = 0, applied = 0
for (const [key, rows] of clusters) {
  if (rows.length < 2) continue
  const approved = rows.filter((r) => r.status === 'approved')

  if (approved.length === 0) {
    console.log(`SKIP  ${key} — ${rows.length} rows, none approved (${rows.map((r) => r.status).join('/')})`)
    skipped++
    continue
  }
  if (approved.length > 1) {
    // Never guess between two approved applications: they may be two genuine
    // stalls run by one person.
    console.log(`SKIP  ${key} — ${approved.length} APPROVED rows, cannot pick a primary`)
    skipped++
    continue
  }

  const primary = approved[0]
  const subs = rows.filter((r) => r.id !== primary.id && !isMerged(r.admin_notes))
  if (!subs.length) continue

  console.log(`MERGE ${key}`)
  console.log(`   primary: ${primary.business_name} (${primary.status}${primary.paid_at ? ', PAID' : ''}) ${primary.id}`)
  for (const sub of subs) {
    console.log(`   sub    : ${sub.business_name} (${sub.status}) ${sub.id}`)
    planned++
    if (APPLY) {
      const next = withMergedMarker(sub.admin_notes as string, primary.id as string)
      const { error: upErr } = await db.from('vendor_applications').update({ admin_notes: next }).eq('id', sub.id)
      if (upErr) console.error(`   !! failed: ${upErr.message}`)
      else applied++
    }
  }
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${APPLY ? applied : planned} subordinate(s) ${APPLY ? 'merged' : 'would be merged'}, ${skipped} cluster(s) skipped.`)
if (!APPLY && planned) console.log('Re-run with --apply to write.')
