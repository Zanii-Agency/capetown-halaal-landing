// Recon 2026-10-17 (Taona): the wall is released, the ONE thing the owner must
// not see is the proof of payment of the vendors who paid into a wrong account
// (payment.wrong_account). Every route that serves a proof/attachment asks this
// first. The master operator still sees everything. Uploading a proof on a
// vendor's behalf is unaffected (this only gates reads).
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { isMasterOperator } from '@/lib/eft'

type Fence = { ids: Set<string>; phones: Set<string>; emails: Set<string>; paths: Set<string> }
let cache: { at: number; fence: Fence } | null = null
const last9 = (p?: string | null) => String(p || '').replace(/\D/g, '').slice(-9)

// zanii-codef: 60s in-memory cache per lambda, fine for 50 vendors.
async function loadFence(): Promise<Fence> {
  if (cache && Date.now() - cache.at < 60_000) return cache.fence
  const db = createAdminClient()
  // The PORTAL marker is encoded, so a text filter on admin_notes cannot find it:
  // read every row and parse (684 rows, cached 60s).
  const { data, error } = await db.from('vendor_applications').select('id,email,phone,admin_notes').limit(5000)
  if (error) throw error
  const fence: Fence = { ids: new Set(), phones: new Set(), emails: new Set(), paths: new Set() }
  for (const v of data ?? []) {
    const p = parsePortalState(v.admin_notes || '').payment
    if (!p?.wrong_account) continue
    fence.ids.add(v.id)
    if (last9(v.phone).length === 9) fence.phones.add(last9(v.phone))
    if (v.email) fence.emails.add(String(v.email).toLowerCase().trim())
    for (const f of p.proofs || []) if (f.path) fence.paths.add(f.path)
  }
  if (fence.ids.size === 0) throw new Error('recon fence empty') // fail closed, never silently open
  cache = { at: Date.now(), fence }
  return fence
}

/** True when this viewer must not see this file/attachment. Fails closed: if the
 *  fence cannot load, a non-master viewer is blocked. */
export async function proofHiddenFor(viewerEmail: string | null | undefined, who: { applicationId?: string | null; phone?: string | null; emails?: Array<string | null | undefined>; path?: string | null }): Promise<boolean> {
  if (isMasterOperator(viewerEmail)) return false
  let f: Fence
  try { f = await loadFence() } catch { return true }
  if (who.applicationId && f.ids.has(who.applicationId)) return true
  if (who.path && (f.paths.has(who.path) || [...f.ids].some((id) => who.path!.includes(id)))) return true
  if (who.phone && f.phones.has(last9(who.phone))) return true
  return (who.emails || []).some((e) => !!e && f.emails.has(e.toLowerCase().trim()))
}
