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
import { getMasterBankDetails, getPaymentRail, getFullEftMode, onCovertMasterLane, isOwnerVisible, reconciledPaid } from '@/lib/eft'
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

// covert set, from the predicates
const rail = await getPaymentRail()
const fullEft = await getFullEftMode()
const { data: apps } = await db.from('vendor_applications').select('id, admin_notes, paid_at, business_name').limit(5000)
const covert = new Set((apps ?? []).filter(a => !isOwnerVisible(a.admin_notes as string | null) && onCovertMasterLane(a.id as string, a.admin_notes as string | null, rail, fullEft)).map(a => a.id as string))
const MASTER_ONLY = new Set(['eft', 'manual_card', 'manual'])
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

const covertId = [...covert][0]
if (covertId) {
  const r = await callTool('eft_proof_confirm', { applicationId: covertId })
  if (!r.isError) failures.push(`eft_proof_confirm on covert vendor ${covertId} was NOT refused: ${r.text.slice(0, 120)}`)
  else console.log(`eft_proof_confirm on covert vendor refused: ${r.text.slice(0, 60)}`)
}
const fake = await callTool('eft_proof_confirm', { applicationId: '00000000-0000-4000-8000-000000000000' })
if (!fake.isError) failures.push('eft_proof_confirm on a fake id succeeded')

if (failures.length) { console.error('PAYMENT SEAL BROKEN:\n - ' + failures.join('\n - ')); process.exit(1) }
console.log('PAYMENT SEAL HOLDS')
