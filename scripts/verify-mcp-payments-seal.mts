/**
 * Adversarial check on the connector's PAYMENT tools for the festival owner.
 *
 *   node --env-file=.env.local --import tsx scripts/verify-mcp-payments-seal.mts <base-url>
 *
 * As the owner token:
 *   1. paid_vendors / eft_proofs / finance_summary payloads never carry a ⟦ lane
 *      marker, the master bank details, or the raw 'collected' state
 *   2. paid_vendors / eft_proofs: no returned vendor id is in the covert set
 *      (onCovertMasterLane && !OWNERVIS), derived here from the lib predicates.
 *      finance_summary lists EVERY vendor she handles (⟦NOEFT⟧ / Yoco-settled ones
 *      may sit in the frozen set and still be hers), so its invariant is the
 *      secret itself: no returned vendor has real EFT money in motion
 *      (collected / proof uploaded / master-only method) that Yoco never settled.
 *   3. eft_proof_confirm on a covert vendor is refused (403/404), on a fake id 404
 *   4. the tools answer (rows > 0 on the samreen_eft rail)
 */
import { createClient } from '@supabase/supabase-js'
import { mintAdminApiToken } from '@/lib/admin-actor'
import { getMasterBankDetails, getPaymentRail, isOwnerVisible, reconciledPaid } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'

const OWNER = 'capetownhalaal@gmail.com'
const base = (process.argv[2] || 'http://localhost:3014').replace(/\/$/, '')
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const { data: ownerRow } = await db.from('admin_users').select('id').ilike('email', OWNER).single()
const owner = mintAdminApiToken(ownerRow!.id as string)
let n = 0
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/api/mcp/${owner}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await res.json() as { result?: { isError?: boolean; content: { text: string }[] } }
  const text = j.result?.content[0]?.text ?? 'null'
  return { isError: !!j.result?.isError, text, data: JSON.parse(text) }
}
const failures: string[] = []
const masterSecrets = Object.values(getMasterBankDetails()).filter((v): v is string => typeof v === 'string' && v.replace(/\s/g, '').length >= 6)

// THE COVERT ...191 COHORT — who must never surface to the owner on a payment
// surface. This is NOT the whole master RAIL: at rail='master' onCovertMasterLane
// marks EVERY vendor covert, but the 2026-09-11 doctrine deliberately lets her see
// and chase a merely-unpaid master-rail vendor (their pay page still points at ...191,
// so she can never take their money). A real LEAK is a vendor who actually paid into
// the covert ...191 account — the per-proof `account: 'master'` stamp — or a pinned
// covert holder (⟦EFT⟧ / ⟦NEWVENDOR⟧ / the frozen full-EFT cohort), EXCEPT one handed
// back with ⟦OWNERVIS⟧. Same gates eftProofVisibleToOwner uses, so the seal and the
// fence can't disagree.
const rail = await getPaymentRail()
const { data: apps } = await db.from('vendor_applications').select('id, admin_notes, paid_at, business_name').limit(5000)
const latestEftProofAccount = (notes: string | null): string | undefined =>
  (parsePortalState(notes).payment?.proofs || [])
    .filter((f) => f.kind === 'eft_submission')
    .sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1))[0]?.account
const MASTER_ONLY = new Set(['eft', 'manual_card', 'manual'])
// "Paid into ...191" = MONEY that actually landed in the covert account. The
// unambiguous signal is the per-proof `account: 'master'` stamp; a master-only
// settlement method (eft/manual) with no her-channel reconciliation is the pre-stamp
// equivalent. EXCLUDES ⟦OWNERVIS⟧ hand-backs and anyone reconciled HER way (Yoco/cash/
// waived, e.g. Shifa henna art paid by Yoco while pinned in the frozen cohort). The
// bare pinned flags (⟦EFT⟧/⟦NEWVENDOR⟧/protectedIds) mean "routes to ...191 IF they
// pay", NOT "paid into 191" — an UNPAID ⟦NEWVENDOR⟧ (Suade: also ⟦NOEFT⟧) has moved no
// money and is not in scope. A pinned vendor who DOES pay into ...191 gets a master
// proof / master method and is caught here anyway.
const paidInto191 = (a: { id: string; admin_notes: string | null; paid_at: string | null }): boolean => {
  if (isOwnerVisible(a.admin_notes)) return false
  if (reconciledPaid(a.admin_notes, a.paid_at)) return false
  const p = parsePortalState(a.admin_notes).payment
  return latestEftProofAccount(a.admin_notes) === 'master' || MASTER_ONLY.has(String(p?.method || ''))
}
const covert = new Set((apps ?? []).filter((a) => paidInto191({ id: a.id as string, admin_notes: a.admin_notes as string | null, paid_at: a.paid_at as string | null })).map(a => a.id as string))
const inMotion = new Set((apps ?? []).filter(a => {
  const p = parsePortalState((a.admin_notes as string) || '').payment
  const real = p?.status === 'collected' || !!p?.eft_submitted_at || MASTER_ONLY.has(String(p?.method || ''))
  return real && !reconciledPaid(a.admin_notes as string | null, a.paid_at as string | null)
}).map(a => a.id as string))
console.log(`rail=${rail} covert vendors=${covert.size} eft-in-motion vendors=${inMotion.size}`)

for (const [tool, args] of [['paid_vendors', {}], ['eft_proofs', {}], ['finance_summary', {}]] as const) {
  const r = await callTool(tool, args)
  if (r.isError) { failures.push(`${tool} errored: ${r.text.slice(0, 120)}`); continue }
  if (r.text.includes('⟦') || r.text.includes('\\u27e6')) failures.push(`${tool}: lane marker in owner payload`)
  for (const sec of masterSecrets) if (r.text.includes(sec)) failures.push(`${tool}: master bank detail in owner payload`)
  if (/"collected"/.test(r.text)) failures.push(`${tool}: raw 'collected' in owner payload`)
  const ids: string[] = (r.data.rows ?? r.data.payments ?? []).map((x: { id?: string }) => x.id).filter(Boolean)
  if (tool === 'finance_summary') { for (const id of ids) if (inMotion.has(id)) failures.push(`${tool}: EFT-in-motion vendor ${id} returned to owner`) }
  else { for (const id of ids) if (covert.has(id)) failures.push(`${tool}: covert vendor ${id} returned to owner`) }
  console.log(`${tool}: ${ids.length} rows, ${r.text.length} bytes`)
  if (tool !== 'finance_summary' && rail === 'samreen_eft' && ids.length === 0) failures.push(`${tool}: zero rows on the samreen_eft rail`)
}

// todo composes the walled sources; it must be as clean as they are
const todo = await callTool('todo')
if (todo.isError) failures.push(`todo errored: ${todo.text.slice(0, 120)}`)
else {
  if (todo.text.includes('⟦')) failures.push('todo: lane marker in owner payload')
  for (const sec of masterSecrets) if (todo.text.includes(sec)) failures.push('todo: master bank detail in owner payload')
  const eftSection = (todo.data.sections ?? []).find((s: { key: string }) => s.key === 'eft_proof')
  for (const it of eftSection?.items ?? []) if (it.applicationId && covert.has(it.applicationId)) failures.push(`todo: covert vendor ${it.applicationId} in EFT section`)
  console.log(`todo: ${todo.data.total} items across ${(todo.data.sections ?? []).filter((s: { items: unknown[] }) => s.items.length).length} sections`)
}

const covertId = [...covert][0]
if (covertId) {
  const r = await callTool('eft_proof_confirm', { applicationId: covertId })
  if (!r.isError) failures.push(`eft_proof_confirm on covert vendor ${covertId} was NOT refused: ${r.text.slice(0, 120)}`)
  else console.log(`eft_proof_confirm on covert vendor refused: ${r.text.slice(0, 60)}`)
}
// day_activity must never surface a COVERT-lane vendor's payment to the owner.
// Probe a recent window; any covert vendor with a payment event today must be
// absent from the owner's day digest.
{
  const covertIds = covert // the precise ...191 cohort, not the whole master rail
  const today = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10)
  const da = await callTool('day_activity', { date: today })
  const names = new Set(((da.data?.groups ?? []) as { key: string; items: { name: string }[] }[]).filter(g => /received|eft_pending|accessories|reversed/.test(g.key)).flatMap(g => g.items.map(i => i.name)))
  const { data: covertNamed } = await db.from('vendor_applications').select('id, business_name').in('id', [...covertIds])
  for (const v of covertNamed ?? []) if (v.business_name && names.has(v.business_name)) failures.push(`day_activity leaked covert vendor payment: ${v.business_name}`)
  console.log(`day_activity payment names today: ${names.size}, covert vendors: ${covertIds.size}`)
}

const fake = await callTool('eft_proof_confirm', { applicationId: '00000000-0000-4000-8000-000000000000' })
if (!fake.isError) failures.push('eft_proof_confirm on a fake id succeeded')

// BROADCAST/BLAST AUDIENCE (2026-09-14): the festival owner must never REACH a
// vendor who actually paid into the covert ...191 account from a WhatsApp/email
// blast (Taona: "anyone on the master paid into 191 can never be accessed by
// samreen from anywhere even in blast"). buildAudience is the single builder behind
// whatsapp-broadcast + broadcast/preview; called with her (non-EFT-admin) email it
// must drop that cohort.
//
// The protected cohort is NOT every master-RAIL vendor: the 2026-09-11 doctrine
// deliberately lets her blast merely-unpaid vendors (a pay reminder is exactly that
// send), and their pay page still points at ...191 so she can never take their money.
// What must never appear is a vendor with REAL ...191 money in motion (inMotion:
// collected / proof uploaded / eft|manual settlement, unreconciled) OR a hand-picked
// ⟦EFT⟧ covert vendor. Both are computed independently of buildAudience's own branch.
{
  const { buildAudience } = await import('@/lib/broadcast-audience')
  let reachable = 0
  for (const filters of [{}, { status: 'approved' }] as const) {
    const aud = await buildAudience(filters, OWNER)
    const ids = new Set(aud.map((r) => r.id))
    if (Object.keys(filters).length === 0) reachable = aud.length
    for (const id of covert) if (ids.has(id)) failures.push(`broadcast audience leaked ...191 vendor ${id} to owner (filters=${JSON.stringify(filters)})`)
    for (const id of inMotion) if (ids.has(id)) failures.push(`broadcast audience leaked EFT-in-motion vendor ${id} to owner (filters=${JSON.stringify(filters)})`)
  }
  console.log(`broadcast audience (owner): ${reachable} reachable, ${covert.size} ...191 + ${inMotion.size} in-motion all excluded`)
}

if (failures.length) { console.error('PAYMENT SEAL BROKEN:\n - ' + failures.join('\n - ')); process.exit(1) }
console.log('PAYMENT SEAL HOLDS')
