// Capture + acknowledge a payment for a NON-marquee / outside vendor.
//
// Marquee vendors pay via Yoco and get a stall code. Bedouin, truck, and loose
// "outside" vendors are NOT allocated on the floor plan — but their money still
// has to be tracked. This endpoint lets an operator record an EFT/cash/manual
// payment against a vendor, tagged with the venue zone, so it shows up in
// /admin/finance alongside Yoco + ticket revenue. State lives in portal_state
// (no DDL — the payment columns don't exist; Law 8).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState } from '@/lib/portal-state'
import { confirmPayment } from '@/lib/payments/confirm'
import { zoneByKey } from '@/lib/venue-zones'
import { notifyOwners } from '@/lib/bot/notify'
import { requireOperator } from '@/lib/admin-rbac'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  applicationId: z.string().uuid(),
  zone: z.string().min(1).max(40), // venue-zones key, or 'outside'
  amount: z.number().positive().max(10_000_000),
  reference: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
})

export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  const { user, adminUser } = gate

  const admin = createAdminClient()

  let parsed: z.infer<typeof bodySchema>
  try {
    parsed = bodySchema.parse(await req.json())
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'invalid body', details: e.issues }, { status: 400 })
    throw e
  }

  // 'outside' is a valid loose bucket; otherwise it must be a known zone.
  const zoneOk = parsed.zone === 'outside' || !!zoneByKey(parsed.zone)
  if (!zoneOk) return NextResponse.json({ error: `unknown zone: ${parsed.zone}` }, { status: 400 })

  const { data: appRow } = await admin
    .from('vendor_applications')
    .select('id, business_name, email')
    .eq('id', parsed.applicationId)
    .single()
  if (!appRow) return NextResponse.json({ error: 'application not found' }, { status: 404 })

  // Route the money through the SAME confirmPayment authority as Yoco + admin
  // mark-paid: it ACCUMULATES into the cumulative paid (first capture or top-up),
  // sets paid_at atomically, and de-dups by providerRef so a double-click does
  // not double-capture (when a reference is supplied). silent: we send our own
  // zone-specific owner notify below. (Was: a direct marker overwrite that reset
  // cumulative paid and re-notified on every POST.)
  const paidAt = new Date().toISOString()
  const providerRef = parsed.reference || `capture-${parsed.applicationId}-${Date.now()}`
  const result = await confirmPayment({
    applicationId: parsed.applicationId,
    method: 'eft',
    amount: parsed.amount,
    providerRef,
    silent: true,
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error || 'capture failed' }, { status: 500 })
  }

  // Layer the zone + capture metadata onto the marker (confirmPayment is
  // zone-agnostic). This merge does NOT touch the cumulative amount/status.
  await updatePortalState(parsed.applicationId, (s) => ({
    ...s,
    payment: {
      ...(s.payment || {}),
      method: 'manual',
      zone: parsed.zone,
      reference: parsed.reference || (s.payment?.reference ?? undefined),
      capture_note: parsed.note,
    },
  }))

  // Audit row.
  try {
    await admin.from('vendor_application_events').insert({
      application_id: parsed.applicationId,
      event_type: 'payment_captured',
      after_value: { amount: parsed.amount, zone: parsed.zone, method: 'manual', reference: parsed.reference || null },
      actor_email: (adminUser.email as string | null) || user.email || null,
      actor_role: 'operator',
      note: parsed.note || null,
    })
  } catch (e) {
    console.error('[capture] audit insert failed:', (e as Error).message)
  }

  const zoneLabel = zoneByKey(parsed.zone)?.label || 'Outside'
  notifyOwners({
    event: 'payment_succeeded',
    body: `${appRow.business_name || 'Vendor'} payment captured (${zoneLabel}): R${parsed.amount.toLocaleString('en-ZA')}${parsed.reference ? ` · ref ${parsed.reference}` : ''}.`,
  }).catch((e) => console.error('[capture] notifyOwners failed:', (e as Error).message))

  return NextResponse.json({
    ok: true,
    applicationId: parsed.applicationId,
    business_name: appRow.business_name,
    amount: parsed.amount,
    zone: parsed.zone,
    zoneLabel,
    paid_at: paidAt,
  })
}
