/**
 * The owner-side EFT proof list: vendors who uploaded proof of an EFT into
 * Samreen's account, with the newest proof file and whether it is confirmed.
 * Fenced by eftProofVisibleToOwner. Populated on EVERY rail — flipping to the
 * master rail only changes which bank details vendors see; the vendors who
 * already paid into HER ...629 account stay listed (2026-09-11: the list used
 * to empty on the master rail, gated on ownerEftActive). Master-account proofs
 * filed after 2026-09-11 carry an account:'master' stamp and the fence hides
 * them; every older proof predates the first master-rail activation, so an
 * unstamped proof that passes the fence is a Samreen-account proof.
 * `ownerEftActive` survives for display only (the bank-details banner is hers
 * only while her account is the one being shown). ONE implementation feeds both
 * the /admin/eft-proofs page and the Claude connector's eft_proofs tool.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { getFullEftMode, getPaymentRail, eftProofVisibleToOwner, eftReference } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { vendorBill } from '@/lib/payments/vendor-bill'
import { nextInstalment } from '@/lib/payments/payment-plan'

/** `reference` = as printed on the proof when we could read it (what she matches on her
 *  statement); `expectedReference` = the one we asked the vendor to use. */
/** amount = the full bill; paidSoFar = money confirmed so far; nextAmount = what the
 *  next confirm records (an instalment on an approved plan, else the balance);
 *  paid = settled in full. */
export type EftProofRow = { id: string; name: string; contact: string | null; reference: string | null; expectedReference: string; amount: number; paidSoFar: number; nextAmount: number; proofUrl: string | null; note: string | null; uploadedAt: string; paid: boolean }

export async function loadEftProofs(): Promise<{ ownerEftActive: boolean; fullEft: Awaited<ReturnType<typeof getFullEftMode>>; rows: EftProofRow[]; totalAmount: number; paidAmount: number }> {
  const db = createAdminClient()
  const fullEft = await getFullEftMode()
  const ownerEftActive = (await getPaymentRail()) === 'samreen_eft'

  const { data: vendors } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at, preferred_booth_tier, special_requirements, status, is_duplicate')
    .neq('status', 'rejected')

  const rows: EftProofRow[] = []
  for (const v of (vendors ?? [])) {
    if ((v as { is_duplicate?: boolean }).is_duplicate) continue
    if (!eftProofVisibleToOwner(v.id as string, v.admin_notes as string | null, fullEft)) continue
    const p = parsePortalState((v.admin_notes as string) || '').payment ?? {}
    const bill = vendorBill({ id: v.id as string, preferred_booth_tier: (v.preferred_booth_tier as string) || null, special_requirements: v.special_requirements, admin_notes: (v.admin_notes as string) || null, paid_at: (v.paid_at as string) || null })
    const inst = nextInstalment(p.arrangement, bill.paidTotal)
    const proofFiles = (p.proofs ?? []).filter((f) => f.kind === 'eft_submission' || f.kind === 'eft_accessories')
    const newest = [...proofFiles].sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1))[0]
    let proofUrl: string | null = null
    if (newest) {
      const { data } = await db.storage.from('vendor-docs').createSignedUrl(newest.path, 60 * 60)
      proofUrl = data?.signedUrl ?? null
    }
    rows.push({
      id: v.id as string,
      name: (v.business_name as string) || (v.contact_name as string) || 'Unnamed',
      contact: (v.contact_name as string) || null,
      reference: newest?.reference ?? null,
      expectedReference: eftReference(v),
      amount: bill.pricing.total,
      paidSoFar: bill.paidTotal,
      nextAmount: inst ? Math.min(inst.amount, bill.owing) : bill.owing,
      proofUrl,
      note: newest?.note ?? null,
      // When the vendor SENT it (proof upload time), never when an operator filed it.
      uploadedAt: newest?.uploaded_at || (p.eft_submitted_at as string) || '',
      paid: bill.settled && bill.owing <= 0,
    })
  }
  rows.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
  const totalAmount = rows.reduce((s, r) => s + r.amount, 0)
  const paidAmount = rows.reduce((s, r) => s + r.paidSoFar, 0)
  return { ownerEftActive, fullEft, rows, totalAmount, paidAmount }
}
