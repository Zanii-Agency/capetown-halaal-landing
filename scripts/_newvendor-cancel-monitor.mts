// READ-ONLY monitor for the 2026-09-10 new-vendor cancellation-warning cohort.
// Re-run any time for a pulse on who responded vs who is still silent. No writes.
//   npx tsx --env-file=.env.local scripts/_newvendor-cancel-monitor.mts
import { createAdminClient } from '@/lib/supabase/admin'
import { hasNewVendorMarker } from '@/lib/eft'
import { parsePortalState, hasPaid } from '@/lib/portal-state'

const SINCE = '2026-09-10T00:00:00Z' // the day the warning went out
const MARKER = '⟦CANCELWARN:2026-09-10⟧'
const last9 = (p: string) => (p || '').replace(/\D/g, '').slice(-9)

const db = createAdminClient()

// 1. The warned cohort.
const { data: vs } = await db.from('vendor_applications')
  .select('id, business_name, phone, email, admin_notes, paid_at, status').eq('status', 'approved')
const cohort = (vs || []).filter(v => hasNewVendorMarker(v.admin_notes as string | null) && (v.admin_notes as string || '').includes(MARKER))

// 2. Inbound WhatsApp since the warning, indexed by last-9 phone.
const waIn = new Set<string>()
try {
  const { data } = await db.from('wa_messages').select('wa_phone, direction, created_at').eq('direction', 'in').gte('created_at', SINCE)
  for (const m of data || []) waIn.add(last9(m.wa_phone as string))
} catch (e) { console.warn('wa_messages read failed:', (e as Error).message) }

// 3. Inbound email since the warning, indexed by peer_email.
const mailIn = new Set<string>()
try {
  const emails = cohort.map(v => (v.email as string || '').toLowerCase()).filter(Boolean)
  const { data: threads } = await db.from('support_inbox_threads').select('id, peer_email')
  const mine = (threads || []).filter(t => emails.includes((t.peer_email as string || '').toLowerCase()))
  const byId = new Map(mine.map(t => [t.id as string, (t.peer_email as string).toLowerCase()]))
  if (mine.length) {
    const { data: msgs } = await db.from('support_inbox_messages')
      .select('thread_id, direction, created_at').in('thread_id', mine.map(t => t.id)).eq('direction', 'in').gte('created_at', SINCE)
    for (const m of msgs || []) { const e = byId.get(m.thread_id as string); if (e) mailIn.add(e) }
  }
} catch (e) { console.warn('support_inbox read failed:', (e as Error).message) }

// 4. Classify each vendor.
type Cls = 'Paid' | 'Arranged' | 'Replied' | 'Silent'
const rows = cohort.map(v => {
  const st = parsePortalState(v.admin_notes as string)
  const arr = st.payment?.arrangement
  const arrangedSince = !!(arr?.agreed_at && arr.agreed_at >= SINCE)
  const repliedWA = waIn.has(last9(v.phone as string))
  const repliedMail = mailIn.has((v.email as string || '').toLowerCase())
  let cls: Cls
  if (hasPaid(st) || v.paid_at) cls = 'Paid'
  else if (arrangedSince || arr?.plan_status) cls = 'Arranged'
  else if (repliedWA || repliedMail) cls = 'Replied'
  else cls = 'Silent'
  return { name: (v.business_name as string) || '?', cls, via: [repliedWA ? 'WA' : '', repliedMail ? 'email' : ''].filter(Boolean).join('+') }
})

const by = (c: Cls) => rows.filter(r => r.cls === c)
const R = (c: Cls) => `${by(c).length}`
console.log(`\n=== New-vendor cancellation-warning monitor — ${cohort.length} warned, as at ${new Date().toISOString().slice(0, 16)}Z ===\n`)
console.log(`Paid:     ${R('Paid')}`)
console.log(`Arranged: ${R('Arranged')}  (plan or extension)`)
console.log(`Replied:  ${R('Replied')}  (messaged us, no money/plan yet)`)
console.log(`SILENT:   ${R('Silent')}  (no response at all)\n`)
for (const c of ['Paid', 'Arranged', 'Replied', 'Silent'] as Cls[]) {
  const list = by(c); if (!list.length) continue
  console.log(`--- ${c} (${list.length}) ---`)
  console.log(list.map(r => r.via ? `${r.name} [${r.via}]` : r.name).sort().join(' · '))
  console.log()
}
