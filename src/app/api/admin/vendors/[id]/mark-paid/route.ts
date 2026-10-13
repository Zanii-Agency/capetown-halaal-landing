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
import { recordAdminAction } from '@/lib/zanii-ledger'
import { withTeamPaid } from '@/lib/eft'

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

  const body = await req.json().catch(() => ({}))
  const method = String(body.method || '').trim() as PaymentMethod
  if (!ALLOWED.includes(method)) {
    return NextResponse.json({ error: `method is required and must be one of: ${ALLOWED.join(', ')}` }, { status: 400 })
  }
  const amount = typeof body.amount === 'number' ? body.amount : undefined
  const reference = body.reference ? String(body.reference).slice(0, 80) : undefined
  const note = body.note ? String(body.note).slice(0, 500) : `Marked paid manually by admin (${method}).`

  // The festival owner cannot mutate master-lane payment state. A blocked admin
  // may still record a team-local paid view, stored only as an admin_notes marker.
  const scope = await laneScopeFor(user.email)
  if (scope.blocksApplicationId(id)) {
    if (!(typeof body.amount === 'number' && Number.isFinite(body.amount) && body.amount > 0)) {
      return NextResponse.json({ error: 'amount is required and must be greater than 0' }, { status: 400 })
    }
    const teamAmount = Math.floor(body.amount)
    if (teamAmount <= 0) {
      return NextResponse.json({ error: 'amount is required and must be at least 1' }, { status: 400 })
    }
    const at = new Date().toISOString()
    const { data: app, error: readError } = await db
      .from('vendor_applications')
      .select('admin_notes')
      .eq('id', id)
      .maybeSingle()
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 })
    if (!app) return NextResponse.json({ error: 'application not found' }, { status: 404 })

    const adminNotes = withTeamPaid(app.admin_notes as string | null, { amount: teamAmount, method, at })
    const { error: updateError } = await db
      .from('vendor_applications')
      .update({ admin_notes: adminNotes })
      .eq('id', id)
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

    try {
      await db.from('vendor_application_events').insert({
        application_id: id,
        event_type: 'payment_team_record',
        after_value: { amount: teamAmount, method, reference, note },
        actor_email: user.email || null,
        actor_role: 'admin',
        note,
      })
    } catch (e) {
      console.warn('mark-paid: team event log insert failed:', (e as Error).message)
    }

    await recordAdminAction({
      actor: { email: gate.adminUser.email, role: gate.role },
      action: 'team_paid_record',
      vendorId: id,
      payload: { method, amount: teamAmount, reference: reference ?? null, note },
    })

    return NextResponse.json({ ok: true, teamRecord: true })
  }

  // Route through the SAME confirmPayment authority as the Yoco webhook and the
  // vendor-ops mark-paid, so a manual payment ACCUMULATES into the cumulative
  // paid (first payment OR top-up) instead of overwriting it, sets the paid_at
  // column atomically, and de-dups by providerRef. A unique ref per manual entry
  // (or the operator's reference) prevents a double-click from double-counting.
  // Notifies the vendor by default: marking someone paid here should send them
  // the "Payment received" confirmation, exactly like Yoco and the sister
  // /admin/payments/mark-paid endpoint. Africa Muslims Agency was marked paid
  // here on 2026-08-10 and got NO confirmation because this was hardcoded
  // silent:true. Pass { silent: true } explicitly for a quiet backfill.
  const providerRef = reference || `manual-${id}-${Date.now()}`
  const result = await confirmPayment({
    applicationId: id,
    method,
    amount,
    providerRef,
    silent: !!body.silent,
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

  await recordAdminAction({
    actor: { email: gate.adminUser.email, role: gate.role },
    action: 'mark_paid',
    vendorId: id,
    payload: { method, amount: result.amount ?? amount ?? null, reference: providerRef, note },
  })

  const after = parsePortalState((await db.from('vendor_applications').select('admin_notes').eq('id', id).maybeSingle()).data?.admin_notes as string || null)
  return NextResponse.json({ ok: true, payment: after.payment })
}
