// Self-service "Add appliances": a signed-in vendor adds more electrical
// appliances after signup. Priced SERVER-SIDE from ELECTRICAL_PRICES (the client
// amount is ignored), appended to special_requirements.electrical_added (a
// separate list that is always summed and never supersedes/drops the vendor's
// original selection). The extra cost lands on accessories.owing, which the
// existing /payments flow charges (card or EFT -ACC). ADD-ONLY: this endpoint
// can only increase the bill, never reduce it, so a vendor cannot lower what
// they already owe by touching it.

import { NextRequest, NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { createAdminClient } from '@/lib/supabase/admin'
import { ELECTRICAL_PRICES } from '@/lib/payments/pricing'
import { vendorBill } from '@/lib/payments/vendor-bill'
import { recordVendorAction } from '@/lib/vendor-action-log'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_QTY = 10

type AddedEntry = { label: string; amount: number; qty: number }

export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const app = ctx.application
  const applicationId = app.id as string

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const rawItems = Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : []

  // Validate every item against the SERVER catalog. Unknown keys are dropped,
  // qty is clamped to [1, MAX_QTY], and amount is the catalog price (never the
  // client's). So a tampered request can only ever add real, correctly-priced
  // catalog appliances.
  const additions: AddedEntry[] = []
  for (const it of rawItems) {
    const key = String((it as { key?: unknown })?.key || '')
    const meta = ELECTRICAL_PRICES[key]
    if (!meta) continue
    const qty = Math.max(1, Math.min(MAX_QTY, Math.floor(Number((it as { qty?: unknown })?.qty) || 1)))
    additions.push({ label: meta.label, amount: meta.price, qty }) // amount = per-unit; pricing applies qty
  }
  if (!additions.length) return NextResponse.json({ error: 'No valid appliances selected' }, { status: 400 })

  // special_requirements is jsonb; tolerate an object or a JSON string.
  const rawReqs = app.special_requirements
  let reqs: Record<string, unknown> = {}
  if (rawReqs && typeof rawReqs === 'object') reqs = { ...(rawReqs as Record<string, unknown>) }
  else if (typeof rawReqs === 'string' && rawReqs.trim()) {
    try { reqs = { ...(JSON.parse(rawReqs) as Record<string, unknown>) } } catch { reqs = {} }
  }
  const existingAdded = Array.isArray(reqs.electrical_added) ? (reqs.electrical_added as AddedEntry[]) : []
  reqs.electrical_added = [...existingAdded, ...additions]

  // Preserve the stored shape: special_requirements is held as a JSON STRING on
  // these rows (computeVendorPricing parses it). Writing a raw object could
  // corrupt a text column, so mirror the shape we read.
  const nextValue: unknown = typeof rawReqs === 'string' ? JSON.stringify(reqs) : reqs

  const db = createAdminClient()
  const { error } = await db.from('vendor_applications').update({ special_requirements: nextValue }).eq('id', applicationId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Recompute the bill from the freshly-written row so the response is truthful.
  const { data: fresh } = await db
    .from('vendor_applications')
    .select('id, preferred_booth_tier, special_requirements, admin_notes, paid_at')
    .eq('id', applicationId)
    .maybeSingle()
  const bill = vendorBill({
    id: applicationId,
    preferred_booth_tier: (fresh?.preferred_booth_tier as string) ?? null,
    special_requirements: fresh?.special_requirements,
    admin_notes: (fresh?.admin_notes as string) ?? null,
    paid_at: (fresh?.paid_at as string) ?? null,
  })

  await recordVendorAction({
    applicationId,
    eventType: 'appliances_added',
    actorEmail: ctx.email,
    note: additions.map((a) => `${a.qty}x ${a.label}`).join(', '),
  })

  return NextResponse.json({
    ok: true,
    added: additions,
    accessoriesTotal: bill.accessories.total,
    accessoriesOwing: bill.accessories.owing,
  })
}
