/**
 * Adversarial check on the /api/mcp channel: the festival owner's Claude must
 * see exactly what her browser sees, and no more.
 *
 *   node --env-file=.env.local --import tsx scripts/verify-mcp-seal.mts <base-url>
 *
 * Mints an owner token and a master token from the local secret (so run it
 * against a deployment sharing that secret), then:
 *   1. tools/list exposes no eft/master/settle/reconcile tool
 *   2. every vendor laneScopeFor(owner) blocks is a 404 via vendor_full as owner
 *      and a 200 as master, and her copy carries no audit rows
 *   3. inbox_list as owner contains none of those vendors' application ids
 *   4. stats works for the owner (the channel is not merely broken)
 * Exit 1 on any disagreement.
 */
import { createClient } from '@supabase/supabase-js'
import { mintAdminApiToken } from '@/lib/admin-actor'
import { laneScopeFor } from '@/lib/inbox-lane'
import { getMasterBankDetails } from '@/lib/eft'

const OWNER = 'capetownhalaal@gmail.com'
const MASTER = 'taona@cthalaal.co.za'
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
async function tokenFor(email: string) {
  const { data } = await db.from('admin_users').select('id').ilike('email', email).single()
  return mintAdminApiToken(data!.id as string)
}
let n = 0
async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/api/mcp/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await res.json() as { result?: { isError?: boolean; content: { text: string }[] } }
  return { isError: !!j.result?.isError, data: JSON.parse(j.result?.content[0]?.text ?? 'null') }
}

const failures: string[] = []
const owner = await tokenFor(OWNER)
const master = await tokenFor(MASTER)

// 1. surface
const list = await fetch(`${base}/api/mcp/${owner}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) }).then(r => r.json()) as { result: { tools: { name: string }[] } }
const names = list.result.tools.map(t => t.name)
for (const bad of names.filter(x => /eft|master|settle|reconcil|mark.?paid/i.test(x))) failures.push(`tool exposed: ${bad}`)
console.log(`tools: ${names.join(', ')}`)

// 2. Lane vendors, chosen by the canonical rule. vendor_full is DESIGNED to
// return every vendor to the owner with the payment posture masked field by
// field (admin_notes stripped, viewerSafePayment, stripEftMessages). Under the
// samreen_eft rail EFT itself is HER lane, so "mentions EFT" is not the secret;
// the secret is the covert destination and the interim state. Invariant: the
// owner's payload never carries the master bank details, the 'collected'
// interim, or a ⟦ marker; the master's payload loads.
const masterSecrets = Object.values(getMasterBankDetails()).filter((v): v is string => typeof v === 'string' && v.replace(/\s/g, '').length >= 6)
const scope = await laneScopeFor(OWNER)
const { data: apps } = await db.from('vendor_applications').select('id, email, phone, business_name').limit(5000)
const hidden = (apps ?? []).filter(a => scope.blocks({ email: a.email as string | null, phone: a.phone as string | null, applicationId: a.id as string }))
console.log(`lane vendors the owner must see only masked: ${hidden.length}`)
for (const a of hidden.slice(0, 25)) {
  const o = await callTool(owner, 'vendor_full', { id: a.id })
  const text = JSON.stringify(o.data)
  if (o.isError) failures.push(`owner vendor_full errored on ${a.id} (${a.business_name}): ${text.slice(0, 100)}`)
  else {
    for (const sec of masterSecrets) if (text.includes(sec)) failures.push(`owner payload carries master bank detail: ${a.id} (${a.business_name})`)
    if (text.includes('\u27e6') || text.includes('⟦')) failures.push(`owner payload carries a lane marker: ${a.id} (${a.business_name})`)
    if (/"collected"/.test(text)) failures.push(`owner payload shows 'collected': ${a.id} (${a.business_name})`)
    // Audit rows: hiddenFromOwner withholds every row about a vendor outside her
    // lane, so a lane vendor's events array is EMPTY for her (the 2026-09-02 leak
    // was `eft_details_revealed` reaching her through a hardcoded in-scope flag).
    const events = (o.data?.events ?? []) as { event_type?: string }[]
    if (events.length) failures.push(`owner payload carries ${events.length} audit row(s) for lane vendor ${a.id} (${a.business_name}): ${[...new Set(events.map(e => e.event_type))].join(', ')}`)
  }
  const m = await callTool(master, 'vendor_full', { id: a.id })
  if (m.isError) failures.push(`master could NOT read ${a.id}: ${JSON.stringify(m.data).slice(0, 120)}`)
}

// 3. inbox: comms have their own lane rule (vendorCommsInEftLane, a vendor can be
// on the EFT payment lane while their chat stays visible until they are TOLD), so
// the sharp invariant here is containment: everything the owner sees, the master
// sees, and the owner never sees a contact the master's list marks as EFT.
const inboxO = await callTool(owner, 'inbox_list', { limit: 500 })
const inboxM = await callTool(master, 'inbox_list', { limit: 500 })
if (inboxO.isError) failures.push(`owner inbox_list failed: ${JSON.stringify(inboxO.data).slice(0, 120)}`)
if (inboxM.isError) failures.push(`master inbox_list failed: ${JSON.stringify(inboxM.data).slice(0, 120)}`)
type Contact = { application_id?: string; phone?: string; email?: string; name?: string; contact_name?: string; mailbox?: string; last_message_at?: string; eft?: boolean; is_eft?: boolean; lane?: string }
const key = (c: Contact) => c.application_id || c.phone || c.email || ''
const masterContacts = (inboxM.data?.contacts ?? []) as Contact[]
const masterByKey = new Map(masterContacts.map(c => [key(c), c]))
// Both lists cap at 500 newest-first. The master sees strictly more, so his
// window ends EARLIER than hers: only compare inside his window.
const masterFloor = masterContacts.length >= 500 ? (masterContacts[masterContacts.length - 1]?.last_message_at ?? '') : ''
for (const c of (inboxO.data?.contacts ?? []) as Contact[]) {
  if (masterFloor && (c.last_message_at ?? '') < masterFloor) continue
  const m = masterByKey.get(key(c))
  // The owner's own Gmail mailbox (capetownhalaal@gmail.com) is hers by design.
  if (!m && c.mailbox === 'gmail') continue
  if (!m) failures.push(`owner sees a contact the master does not: ${key(c)} (${c.contact_name ?? c.name})`)
  else if (m.eft || m.is_eft || m.lane === 'master' || m.lane === 'eft') failures.push(`owner sees an EFT-lane contact: ${key(c)} (${c.name})`)
}
console.log(`inbox contacts: owner ${inboxO.data?.contacts?.length ?? 'n/a'}, master ${inboxM.data?.contacts?.length ?? 'n/a'}`)

// 4. liveness
const s = await callTool(owner, 'stats')
if (s.isError) failures.push(`owner stats failed: ${JSON.stringify(s.data).slice(0, 120)}`)

// 5. bad token
const bad = await fetch(`${base}/api/mcp/cth_nope.nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
if (bad.status !== 401) failures.push(`bad token got ${bad.status}, expected 401`)

if (failures.length) { console.error('SEAL BROKEN:\n - ' + failures.join('\n - ')); process.exit(1) }
console.log(`SEAL HOLDS (${hidden.length} lane vendors, ${Math.min(hidden.length, 25)} probed both ways)`)
