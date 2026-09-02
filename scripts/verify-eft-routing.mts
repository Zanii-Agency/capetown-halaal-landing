// READ-ONLY. Proves isEftScopedAlert against real vendor_applications rows —
// no writes, no sends. Asserts the routing decision matches the 2026-07-25 rule
// per lane class, so the fix is verified on production data, not just fixtures.
//   node --import tsx --env-file=.env.local scripts/_verify-gate.mts
import { createAdminClient } from '@/lib/supabase/admin'
import { getEftMode, hasEftMarker, hasNoEftMarker, isInternalAccount } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { isEftScopedAlert } from '@/lib/bot/notify'

const mask = (s: unknown) => (typeof s === 'string' && s ? s.slice(0, 3) + '***' + s.slice(-4) : '—')
const NEUTRAL = 'Staff badge added by X: Y.'

type Row = { id: string; business_name: unknown; admin_notes: unknown; paid_at: unknown; email: unknown; phone: unknown }
// Classify each row independently of the predicate under test, then assert the
// predicate agrees. Deriving "expected" from the same helper would prove nothing.
type Cls = 'internal' | 'noeft' | 'reconciled' | 'collected' | 'marked' | 'submitted' | 'swept'

function classify(r: Row): Cls {
  const notes = (r.admin_notes as string) || ''
  const p = parsePortalState(notes).payment
  if (isInternalAccount(r.email as string, r.phone as string)) return 'internal'
  if (hasNoEftMarker(notes)) return 'noeft'
  if (r.paid_at || p?.status === 'paid') return 'reconciled'
  if (p?.status === 'collected') return 'collected'
  if (hasEftMarker(notes)) return 'marked'
  if (p?.eft_submitted_at) return 'submitted'
  return 'swept'
}

// Per the rule: owner KEEPS internal / excluded / reconciled. Everything else is
// master-only (marked, collected, mid-transaction, and swept while global is on).
const expected = (c: Cls, globalOn: boolean): boolean =>
  c === 'internal' || c === 'noeft' || c === 'reconciled' ? false : c === 'swept' ? globalOn : true

async function main() {
  const db = createAdminClient()
  const globalOn = await getEftMode()
  const { data, error } = await db
    .from('vendor_applications')
    .select('id, business_name, admin_notes, paid_at, email, phone')
    .eq('status', 'approved')
  if (error) throw error
  const rows = (data || []) as Row[]

  const tally: Record<string, { n: number; bad: number }> = {}
  let mismatches = 0
  for (const r of rows) {
    const c = classify(r)
    const got = isEftScopedAlert({ body: NEUTRAL }, r, globalOn)
    const want = expected(c, globalOn)
    tally[c] ??= { n: 0, bad: 0 }
    tally[c].n++
    if (got !== want) {
      tally[c].bad++
      mismatches++
      console.log(`MISMATCH [${c}] ${r.business_name} paid_at=${r.paid_at} got=${got} want=${want}`)
    }
  }

  console.log(`\nEFT global mode: ${globalOn ? 'ON' : 'OFF'} · ${rows.length} approved vendors\n`)
  console.log('  class         n   routing')
  for (const [c, t] of Object.entries(tally).sort()) {
    const withheld = expected(c as Cls, globalOn)
    console.log(`  ${c.padEnd(11)} ${String(t.n).padStart(3)}   ${withheld ? 'MASTER only' : 'owner sees'}${t.bad ? `  ✗ ${t.bad} MISMATCH` : ''}`)
  }

  const kk = rows.find((r) => /krispy/i.test(String(r.business_name || '')))
  if (kk) {
    const reconciled = { ...kk, paid_at: '2026-07-25T00:00:00Z' }
    console.log(`\nreported vendor: ${kk.business_name} [${classify(kk)}] email=${mask(kk.email)} phone=${mask(kk.phone)}`)
    console.log(`  staff-badge alert withheld from owner : ${isEftScopedAlert({ body: NEUTRAL }, kk, globalOn)}   (want true)`)
    console.log(`  same alert once reconciled            : ${isEftScopedAlert({ body: NEUTRAL }, reconciled, globalOn)}  (want false)`)
    console.log(`  confirm.ts "marked paid via eft" body : ${isEftScopedAlert({ body: `${kk.business_name} marked paid via eft. Amount R4,500.` }, reconciled, globalOn)}  (want false — she MUST be told)`)
  }
  console.log(`\n${mismatches === 0 ? 'OK: every approved vendor routes per the rule' : `FAIL: ${mismatches} mismatches`}`)
  process.exit(mismatches === 0 ? 0 : 1)
}

main()
