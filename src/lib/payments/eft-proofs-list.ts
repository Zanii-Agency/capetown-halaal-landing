/**
 * The owner-side EFT proof list: vendors who uploaded proof of an EFT into
 * Samreen's account, with the newest proof file and whether it is confirmed.
 * Fenced by eftProofVisibleToOwner and only populated on the samreen_eft rail
 * (on the covert rail nothing may surface). ONE implementation feeds both the
 * /admin/eft-proofs page and the Claude connector's eft_proofs tool.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { getFullEftMode, getPaymentRail, eftProofVisibleToOwner, eftReference, rosterPaid } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { computeVendorPricing } from '@/lib/payments/pricing'

export type EftProofRow = { id: string; name: string; contact: string | null; reference: string; amount: number; proofUrl: string | null; note: string | null; uploadedAt: string; paid: boolean }

export async function loadEftProofs(): Promise<{ ownerEftActive: boolean; fullEft: Awaited<ReturnType<typeof getFullEftMode>>; rows: EftProofRow[]; totalAmount: number; paidAmount: number }> {
  const db = createAdminClient()
  const fullEft = await getFullEftMode()
  const ownerEftActive = (await getPaymentRail()) === 'samreen_eft'

  const { data: vendors } = ownerEftActive ? await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at, preferred_booth_tier, special_requirements, status, is_duplicate')
    .neq('status', 'rejected') : { data: [] as Array<Record<string, unknown>> }

  const rows: EftProofRow[] = []
  for (const v of (vendors ?? [])) {
    if ((v as { is_duplicate?: boolean }).is_duplicate) continue
    if (!eftProofVisibleToOwner(v.id as string, v.admin_notes as string | null, fullEft)) continue
    const p = parsePortalState((v.admin_notes as string) || '').payment ?? {}
    const bill = computeVendorPricing({ preferred_booth_tier: v.preferred_booth_tier, special_requirements: v.special_requirements }).total
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
      reference: eftReference(v),
      amount: bill,
      proofUrl,
      note: newest?.note ?? null,
      uploadedAt: (p.eft_submitted_at as string) || newest?.uploaded_at || '',
      paid: rosterPaid(v.admin_notes as string | null, v.paid_at as string | null),
    })
  }
  rows.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
  const totalAmount = rows.reduce((s, r) => s + r.amount, 0)
  const paidAmount = rows.filter((r) => r.paid).reduce((s, r) => s + r.amount, 0)
  return { ownerEftActive, fullEft, rows, totalAmount, paidAmount }
}
