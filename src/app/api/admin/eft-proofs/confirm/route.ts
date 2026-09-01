/**
 * POST /api/admin/eft-proofs/confirm  { applicationId }
 *
 * The festival owner's "Mark as paid" for a vendor on HER EFT-proofs surface
 * (/admin/eft-proofs). She has checked the uploaded proof and the money is in
 * the reconciled account (...629); this settles the stall fee.
 *
 * WHY NOT /api/admin/vendors/[id]/mark-paid:
 * that route gates on laneScopeFor, which blocks the owner from ANY vendor with
 * an eft_submitted_at — i.e. every single row on this page (a proof-in vendor
 * fails vendorInOwnerScope). So it 403s her on exactly the vendors she is meant
 * to reconcile. This route uses the SAME fence the page renders with
 * (eftProofVisibleToOwner), which already excludes every covert / frozen /
 * ⟦EFT⟧ vendor. A proof visible on this page is legitimately hers to confirm,
 * and nothing covert can reach this endpoint.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'
import { confirmPayment } from '@/lib/payments/confirm'
import { getFullEftMode, getPaymentRail, eftProofVisibleToOwner } from '@/lib/eft'
import { parsePortalState, syncPortalState } from '@/lib/portal-state'
import { recordAdminAction } from '@/lib/zanii-ledger'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response

  const body = await req.json().catch(() => ({}))
  const id = String(body.applicationId || '').trim()
  if (!id) return NextResponse.json({ error: 'applicationId required' }, { status: 400 })

  const db = createAdminClient()
  const { data: app } = await db
    .from('vendor_applications')
    .select('id, admin_notes, paid_at, is_duplicate')
    .eq('id', id)
    .maybeSingle()
  if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // AUTHORIZATION = exactly what makes this row appear on the page. rail must be
  // samreen_eft (the only rail on which this page shows anything) AND the vendor
  // must pass the owner fence. The fence already walls off every covert/protected
  // vendor, so this cannot confirm anyone hidden from her. Deliberately NOT
  // laneScopeFor (see file header).
  const [fullEft, rail] = await Promise.all([getFullEftMode(), getPaymentRail()])
  const notes = app.admin_notes as string | null
  if (
    (app as { is_duplicate?: boolean }).is_duplicate ||
    rail !== 'samreen_eft' ||
    !eftProofVisibleToOwner(id, notes, fullEft)
  ) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Same authority as the Yoco webhook and the manual mark-paid: cumulative,
  // atomic (paid_at IS NULL transition), de-duped by providerRef, and it sends
  // the vendor their "Payment received" confirmation. Method 'eft' is honest
  // (they paid EFT into the reconciled account); finance counts it via rosterPaid
  // and the vendor roster reads PAID. A stable providerRef makes a double-click
  // idempotent — one confirm per vendor, never a double-count.
  const result = await confirmPayment({
    applicationId: id,
    method: 'eft',
    providerRef: `eftproof-${id}`,
  })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 500 })

  try {
    await db.from('vendor_application_events').insert({
      application_id: id,
      event_type: 'payment_manual',
      after_value: { total_paid: result.amount, method: 'eft', reference: `eftproof-${id}`, source: 'eft-proofs' },
      actor_email: gate.adminUser.email,
      actor_role: 'admin',
      note: 'EFT proof confirmed from the EFT Proofs page',
    })
  } catch (e) {
    console.warn('[eft-proofs/confirm] event log insert failed:', (e as Error).message)
  }

  await syncPortalState(id, db).catch((e) =>
    console.error('[eft-proofs/confirm] syncPortalState failed:', (e as Error).message),
  )

  await recordAdminAction({
    actor: { email: gate.adminUser.email, role: gate.role },
    action: 'mark_paid',
    vendorId: id,
    payload: { method: 'eft', amount: result.amount ?? null, reference: `eftproof-${id}`, source: 'eft-proofs' },
  })

  const after = parsePortalState(
    (await db.from('vendor_applications').select('admin_notes').eq('id', id).maybeSingle()).data?.admin_notes as string || null,
  )
  return NextResponse.json({ ok: true, payment: after.payment })
}
