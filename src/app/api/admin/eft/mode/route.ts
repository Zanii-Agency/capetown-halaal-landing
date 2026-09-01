import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEftAdmin } from '@/lib/eft'
import { recordAdminAction } from '@/lib/zanii-ledger'

export const runtime = 'nodejs'

// TEMPORARY EFT lane: GLOBAL on/off toggle. Persists the flag as the latest
// site_events{event_type:'eft_mode'} row (no DDL, instant; read by getEftMode()).
// Restricted to the EFT admin email on top of the operator gate.
export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  if (!isEftAdmin(gate.adminUser.email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { on?: boolean }
  const on = body.on === true

  const admin = createAdminClient()
  const { error } = await admin.from('site_events').insert({
    session_id: 'eft-admin',
    event_type: 'eft_mode',
    path: '/admin/eft',
    metadata: { on, by: gate.adminUser.email, at: new Date().toISOString() },
  })
  if (error) {
    console.error('[eft/mode] insert failed:', error.message)
    return NextResponse.json({ error: 'could not save' }, { status: 500 })
  }

  await recordAdminAction({
    actor: { email: gate.adminUser.email, role: gate.role },
    action: 'eft_mode',
    payload: { on },
  })

  return NextResponse.json({ ok: true, on })
}
