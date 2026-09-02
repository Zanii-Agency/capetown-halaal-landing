import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEftAdmin, type PaymentRail } from '@/lib/eft'
import { recordAdminAction } from '@/lib/zanii-ledger'

export const runtime = 'nodejs'

const RAILS: readonly PaymentRail[] = ['yoco', 'samreen_eft', 'master']

// GLOBAL payment-rail selector. Persists the choice as the latest
// site_events{event_type:'eft_mode'} row (no DDL, instant; read by getPaymentRail()).
// Restricted to the EFT admin email on top of the operator gate: Samreen can never
// reach here, so she can never see or choose the covert master lane. Accepts the
// three-way { mode } and, for backward compatibility, the old { on } boolean
// (on -> samreen_eft, off -> yoco).
export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  if (!isEftAdmin(gate.adminUser.email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { mode?: string; on?: boolean }
  const mode: PaymentRail | null =
    body.mode && (RAILS as readonly string[]).includes(body.mode) ? (body.mode as PaymentRail)
    : typeof body.on === 'boolean' ? (body.on ? 'samreen_eft' : 'yoco')
    : null
  if (!mode) return NextResponse.json({ error: 'mode must be one of yoco | samreen_eft | master' }, { status: 400 })

  const admin = createAdminClient()
  const { error } = await admin.from('site_events').insert({
    session_id: 'eft-admin',
    event_type: 'eft_mode',
    path: '/admin/eft',
    // `on` is written alongside `mode` so any legacy reader still on getEftMode()'s
    // old boolean shape keeps working until every caller is migrated.
    metadata: { mode, on: mode !== 'yoco', by: gate.adminUser.email, at: new Date().toISOString() },
  })
  if (error) {
    console.error('[eft/mode] insert failed:', error.message)
    return NextResponse.json({ error: 'could not save' }, { status: 500 })
  }

  await recordAdminAction({
    actor: { email: gate.adminUser.email, role: gate.role },
    action: 'eft_mode',
    payload: { mode },
  })

  return NextResponse.json({ ok: true, mode })
}
