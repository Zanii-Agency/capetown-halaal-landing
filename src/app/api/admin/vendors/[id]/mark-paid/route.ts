/**
 * POST /api/admin/vendors/[id]/mark-paid
 *
 * Mark a vendor's stall fee paid manually (cash, EFT off-platform, comp).
 * Writes:
 *   - portal-state marker `payment.status = 'paid'` + paid_at + reference + method
 *   - vendor_application_events entry { event_type: 'payment_manual', note: ... }
 *
 * Body: { method: 'eft'|'cash'|'manual_card'|'waived', amount?: number, reference?: string, note?: string }
 * method is REQUIRED (Taona 2026-07-12: "it should ask how they paid") — this
 * used to hardcode 'eft' for every manual payment regardless of reality, which
 * also made the invoice always claim "Paid via Yoco" (see invoice-pdf.ts).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, syncPortalState } from '@/lib/portal-state'
import { confirmPayment, type PaymentMethod } from '@/lib/payments/confirm'
import { requireOperator } from '@/lib/admin-rbac'
import { laneScopeFor } from '@/lib/inbox-lane'

const ALLOWED: PaymentMethod[] = ['eft', 'cash', 'manual_card', 'waived']

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  const { user } = gate
  const db = createAdminClient()

  // The festival owner cannot record payments against master-lane vendors.
  const scope = await laneScopeFor(user.email)
  if (scope.blocksApplicationId(id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const method = String(body.method || '').trim() as PaymentMethod
  if (!ALLOWED.includes(method)) {
    return NextResponse.json({ error: `method is required and must be one of: ${ALLOWED.join(', ')}` }, { status: 400 })
  }
  const amount = typeof body.amount === 'number' ? body.amount : undefined
  const reference = body.reference ? String(body.reference).slice(0, 80) : undefined
  const note = body.note ? String(body.note).slice(0, 500) : `Marked paid manually by admin (${method}).`

  // Route through the SAME confirmPayment authority as the Yoco webhook and the
  // vendor-ops mark-paid, so a manual payment ACCUMULATES into the cumulative
  // paid (first payment OR top-up) instead of overwriting it, sets the paid_at
  // column atomically, and de-dups by providerRef. A unique ref per manual entry
  // (or the operator's reference) prevents a double-click from double-counting.
  // silent: the operator is recording an offline payment, so no auto vendor /
  // owner sends (matches the prior behaviour of this endpoint).
  const providerRef = reference || `manual-${id}-${Date.now()}`
  const result = await confirmPayment({
    applicationId: id,
    method,
    amount,
    providerRef,
    silent: true,
  })
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 })
  }

  try {
    await db.from('vendor_application_events').insert({
      application_id: id,
      event_type: 'payment_manual',
      after_value: { amount, total_paid: result.amount, method, reference: providerRef, note },
      actor_email: user.email || null,
      actor_role: 'admin',
      note,
    })
  } catch (e) {
    console.warn('mark-paid: event log insert failed:', (e as Error).message)
  }

  await syncPortalState(id, db).catch((e) =>
    console.error('[mark-paid] syncPortalState failed:', (e as Error).message)
  )

  const after = parsePortalState((await db.from('vendor_applications').select('admin_notes').eq('id', id).maybeSingle()).data?.admin_notes as string || null)
  return NextResponse.json({ ok: true, payment: after.payment })
}
