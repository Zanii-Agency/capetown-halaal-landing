/**
 * Post-outage verification. Run after the Supabase project comes back.
 *
 *   npx tsx --env-file=.env.local scripts/verify-post-recovery.mts
 *
 * WHY THIS EXISTS. On 2026-07-28 the CTH Postgres origin went down for about an
 * hour (429 too_many_connections / 544 DatabaseTimeout) in the middle of a
 * session that changed the mail loader's pagination, the lane seal's status
 * rule, and the approval-email delivery check. Every one of those changes was
 * shipped on the strength of unit tests and a clean build, with NOTHING observed
 * against live data. This script is the observation that was owed.
 *
 * It answers five questions with evidence rather than reasoning, and it is
 * deliberately willing to report that a fix changed nothing.
 *
 * Companion to verify-channel-seal.mts, which is the narrower adversarial seal
 * check. Run both.
 */

import { loadWhatsAppThreads, loadMailThreads } from '../src/lib/inbox/channel-threads'
import { createAdminClient } from '../src/lib/supabase/admin'
import { laneScopeFor } from '../src/lib/inbox-lane'

const SAMREEN = 'capetownhalaal@gmail.com'
const MASTER = 'dev@cthalaal.co.za' // EFT_ADMIN_EMAIL, not taona@ who is lane-restricted himself
const TARGET = 'ft@halalrc.org'

/** Addresses that hard-bounced onto Resend's suppression list, plus Amiena, who
 *  bounces repeatedly without ever landing on it. */
const UNREACHABLE = [
  'raeesajenkjns@gmail.com',
  'tasneem@chocotag.com',
  'soaprettyshop@gmail.com',
  'simplyedcationalandtoys@gmail.com',
  'amiena.3110@gmail.com',
]

const db = createAdminClient()
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line('='.repeat(70)); line(s); line('='.repeat(70)) }

let failures = 0

// ---------------------------------------------------------------------------
h('1. MAIL PAGING: did the fix actually recover anything?')
// loadMailThreads used .limit(4000), which PostgREST truncates to 1000 here. If
// the table is under 1000 rows the fix is correct but has not yet DONE anything,
// and saying so is the honest result.
const { count: msgCount } = await db
  .from('support_inbox_messages').select('id', { count: 'exact', head: true })
const { count: threadCount } = await db
  .from('support_inbox_threads').select('id', { count: 'exact', head: true })

line(`support_inbox_messages: ${msgCount ?? '?'} rows`)
line(`support_inbox_threads:  ${threadCount ?? '?'} rows`)
if ((msgCount ?? 0) <= 1000) {
  line('  -> under the old 1000-row cap: fix is CORRECT BUT NOT YET LOAD-BEARING.')
} else {
  line(`  -> ${(msgCount ?? 0) - 1000} rows sat outside the old window; any thread whose`)
  line('     newest message lived there was invisible to EVERYONE, master included.')
}

const sup = await loadMailThreads(MASTER, 'support')
const gm = await loadMailThreads(MASTER, 'gmail')
const seen = sup.length + gm.length
line(`loader sees as master: support=${sup.length} gmail=${gm.length} total=${seen}`)
if (threadCount && seen < threadCount) {
  failures++
  line(`  FAIL: ${threadCount - seen} threads still not surfacing; coverage incomplete.`)
} else if (threadCount) {
  line('  OK: every thread in the table surfaces in the loader.')
}

// ---------------------------------------------------------------------------
h(`2. ${TARGET}: does it reach Samreen?`)
const { data: thr } = await db
  .from('support_inbox_threads')
  .select('id, peer_email, subject, vendor_application_id, last_inbound_at')
  .ilike('peer_email', TARGET)

if (!thr?.length) {
  line(`No thread with peer_email = ${TARGET}. Nothing to be visible or hidden.`)
} else {
  for (const t of thr) {
    line(`thread ${t.id}  "${t.subject}"  last_inbound=${t.last_inbound_at}  app=${t.vendor_application_id ?? 'none'}`)
  }
  const { data: vend } = await db
    .from('vendor_applications').select('*').ilike('email', TARGET)
  if (!vend?.length) {
    line('No vendor_applications row -> generic sender -> she should see it.')
  } else {
    for (const v of vend as Array<Record<string, unknown>>) {
      line(`vendor ${v.id} "${v.business_name}" status=${v.status ?? 'NULL'} paid_at=${v.paid_at ?? 'null'}`)
      if (v.status === 'approved' && !v.paid_at) {
        line('  -> approved + unpaid: BLOCKED by design. The fix is DATA, not code:')
        line('     stamp OWNERVIS on this row (withOwnerVisibleMarker, src/lib/eft.ts).')
      }
    }
  }
  // The only answer that counts: run the real loader as her.
  const hers = [
    ...await loadMailThreads(SAMREEN, 'support'),
    ...await loadMailThreads(SAMREEN, 'gmail'),
  ]
  const visible = hers.some((x) => (x.email || '').toLowerCase() === TARGET)
  line(`ACTUAL LOADER RESULT for Samreen: ${visible ? 'VISIBLE' : 'NOT VISIBLE'}`)
}

// ---------------------------------------------------------------------------
h('3. SEAL: does it still WITHHOLD something?')
// "No leaks" is also what a filter blocking nothing looks like.
for (const [label, load] of [
  ['whatsapp', (v: string) => loadWhatsAppThreads(v)],
  ['support', (v: string) => loadMailThreads(v, 'support')],
  ['gmail', (v: string) => loadMailThreads(v, 'gmail')],
] as const) {
  const master = await load(MASTER)
  const owner = await load(SAMREEN)
  const ids = new Set(owner.map((t) => t.id))
  const withheld = master.filter((t) => !ids.has(t.id)).length
  line(`${label.padEnd(9)} master=${String(master.length).padStart(4)} owner=${String(owner.length).padStart(4)} withheld=${withheld}`)
  if (withheld === 0) { failures++; line('   FAIL: withheld nothing, so the seal was never exercised here.') }
}

// ---------------------------------------------------------------------------
h('4. NULL-status vendors: how much would the rejected "fix" have leaked?')
// An agent proposed defaulting a NULL status to 'pending'. Applied, every row
// below carrying the EFT marker would have become readable by Samreen.
const { data: nulls, error: nullErr } = await db
  .from('vendor_applications').select('*').is('status', null)
if (nullErr) {
  line(`could not query: ${nullErr.message}`)
} else {
  line(`rows with status IS NULL: ${nulls?.length ?? 0}`)
  const scope = await laneScopeFor(SAMREEN)
  for (const r of (nulls || []) as Array<Record<string, unknown>>) {
    const eft = /⟦EFT⟧/.test(String(r.admin_notes || ''))
    const blocked = scope.blocksApplicationId(String(r.id))
    line(`  ${r.business_name ?? r.email}  eft=${eft}  blocked=${blocked}${eft && !blocked ? '   <-- WOULD HAVE LEAKED' : ''}`)
  }
}

// ---------------------------------------------------------------------------
h('5. THE UNREACHABLE VENDORS: how do we actually reach them?')
for (const email of UNREACHABLE) {
  const { data: v } = await db
    .from('vendor_applications').select('*').ilike('email', email).maybeSingle()
  if (!v) { line(`${email}: no vendor row`); continue }
  const row = v as Record<string, unknown>
  const key = String(row.phone || '').replace(/\D/g, '').slice(-9)
  let wa = 0
  if (key) {
    const { count } = await db.from('wa_messages')
      .select('id', { count: 'exact', head: true }).like('wa_phone', `%${key}`)
    wa = count ?? 0
  }
  const notified = /⟦APPROVED_NOTIFIED/.test(String(row.admin_notes || ''))
  line(`${row.business_name ?? email}`)
  line(`   contact=${row.contact_name ?? '?'}  phone=${row.phone ?? 'NONE'}  status=${row.status ?? 'NULL'}`)
  line(`   waMessages=${wa}  contractSigned=${!!row.contract_signed_at}`)
  line(`   APPROVED_NOTIFIED=${notified}${notified ? '   <-- claims notified, never delivered' : ''}`)
  line(`   -> route: ${wa > 0 ? 'WhatsApp (thread exists)' : row.phone ? 'WhatsApp (no thread yet, needs a template)' : 'NO PHONE — needs a human'}`)
}

line()
line(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
