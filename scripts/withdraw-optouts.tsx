// Close out vendors who told us they are not trading this year but were left on
// status='approved', so the payment cron and the manual chase batches kept
// billing them (2026-07-25).
//
// Mirrors DELETE /api/admin/vendors/[id] exactly (soft withdraw): free the
// stalls, stamp the ⟦PORTAL⟧ `withdrawn` marker, set status='rejected', write a
// vendor_application_events audit row. Same helpers, so the marker shape stays
// identical and the action is reversible from the Applications screen.
// status='rejected' is what drops them from every approved-vendor query,
// including src/app/api/cron/payment-reminders/route.ts:81.
//
// Sends NO email. The apology is a separate, reviewed send.
//
//   node --env-file=.env.local --import tsx scripts/withdraw-optouts.tsx          # DRY
//   SEND=1 node --env-file=.env.local --import tsx scripts/withdraw-optouts.tsx   # apply

import { config } from 'dotenv'
config({ path: '.env.local' })

import { parseAllocation } from '../src/lib/stalls'
import { parsePortalState, updatePortalStateImpl } from '../src/lib/portal-state'

const DRY = process.env.SEND !== '1'
const ACTOR = 'admin@youngatheart.co.za'

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

// business_name (lowercased) -> the vendor's own words + when they said it.
const WITHDRAWN: Record<string, string> = {
  'layali haus': 'Vendor withdrew 6 July 2026 on WhatsApp and email: not attending this year due to personal circumstances. Repeated 20 and 25 July.',
  'the meeaad range': 'Vendor withdrew 20 July 2026 on WhatsApp (OTP-verified) and by email 23 July: not taking up the space, asked us to reoffer it.',
  'second season': 'Vendor withdrew 23 July 2026 by email: requested their application be removed for this year.',
  'hermanos chicken': 'Vendor withdrew 13 July 2026 by email: cannot make the festival this year, asked us to offer the space to another vendor.',
}

type Row = { id: string; business_name: string | null; contact_name: string | null; email: string | null; status: string; admin_notes: string | null }

async function main() {
  const url = `${BASE}/rest/v1/vendor_applications?select=id,business_name,contact_name,email,status,admin_notes`
  const all = (await (await fetch(url, { headers: h })).json()) as Row[]

  console.log(`\n${DRY ? 'DRY RUN (no writes)' : 'APPLYING'} — withdraw ${Object.keys(WITHDRAWN).length} vendor(s)\n${'='.repeat(70)}`)
  let done = 0
  const fails: string[] = []

  for (const [key, reason] of Object.entries(WITHDRAWN)) {
    const rows = all.filter((r) => (r.business_name || '').trim().toLowerCase() === key)
    if (!rows.length) { fails.push(`NO ROW for "${key}"`); continue }

    for (const r of rows) {
      if (r.status !== 'approved') { console.log(`SKIP ${r.business_name}: already ${r.status}`); continue }
      const notes = r.admin_notes || ''
      const { stalls: freedStalls, human: notesNoStall } = parseAllocation(notes)
      const state = parsePortalState(notes)
      ;(state as unknown as { withdrawn?: unknown }).withdrawn = {
        at: new Date().toISOString(),
        by: ACTOR,
        reason,
        ...(freedStalls.length ? { freed_stalls: freedStalls } : {}),
      }
      const newNotes = updatePortalStateImpl(notesNoStall, state as never)

      console.log(`\n### ${r.business_name} (${r.contact_name}, ${r.email})`)
      console.log(`  approved -> rejected, stalls freed: ${freedStalls.join(', ') || 'none'}`)
      console.log(`  reason: ${reason}`)
      if (DRY) continue

      const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${r.id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'rejected', admin_notes: newNotes }),
      })
      if (!pr.ok) { fails.push(`${key}: ${pr.status} ${await pr.text()}`); continue }
      done++

      // Audit row, mirroring the endpoint. Never block on a logging failure.
      const ev = await fetch(`${BASE}/rest/v1/vendor_application_events`, {
        method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          application_id: r.id,
          event_type: 'vendor_withdrawn',
          before_value: { status: r.status, stalls: freedStalls },
          after_value: { status: 'rejected', withdrawn: (state as unknown as { withdrawn: unknown }).withdrawn },
          actor_email: ACTOR,
          actor_role: 'operator',
          note: `Vendor withdrawn: ${reason}`,
        }),
      })
      console.log(`  withdrawn${ev.ok ? ' + audit logged' : ` (audit log failed: ${ev.status})`}`)
    }
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log(DRY ? 'dry run, nothing written' : `withdrawn: ${done}`)
  if (fails.length) { console.log(`FAILURES (${fails.length}):`); fails.forEach((f) => console.log(`  - ${f}`)) }
}

main().catch((e) => { console.error(e); process.exit(1) })
