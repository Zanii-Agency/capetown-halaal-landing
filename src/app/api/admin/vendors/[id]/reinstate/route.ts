/**
 * POST /api/admin/vendors/[id]/reinstate
 *
 * Reverse a withdrawal: clear the ⟦PORTAL⟧ withdrawn marker and set status back
 * to 'approved'. The vendor rejoins the roster + Excel immediately. Owner/operator
 * only (same gate as withdraw / mark-paid). Does NOT re-allocate the freed stall.
 * Taona 2026-08-25: "reinstate function must be with her and auto on any withdrawn
 * vendor" — the profile shows the button on every withdrawn vendor.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'
import { reinstateApplication } from '@/lib/vendors/withdraw'
import { recordAdminAction } from '@/lib/zanii-ledger'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid application id' }, { status: 400 })
    }

    const gate = await requireOperator()
    if (!gate.ok) return gate.response

    const db = createAdminClient()
    const out = await reinstateApplication(db, {
      applicationId: id,
      actorEmail: gate.adminUser.email,
      actorRole: 'operator',
    })

    if (!out.ok) {
      const status = out.reason === 'not_found' ? 404 : 400
      const message =
        out.reason === 'not_found'
          ? 'Application not found'
          : `${out.businessName || 'This vendor'} is not withdrawn, so there is nothing to reinstate.`
      return NextResponse.json({ error: message, reason: out.reason }, { status })
    }

    await recordAdminAction({
      actor: { email: gate.adminUser.email, role: gate.role },
      action: 'reinstate',
      vendorId: id,
      payload: { business_name: out.businessName },
    })

    return NextResponse.json({ ok: true, business_name: out.businessName, status: 'approved' })
  } catch (err) {
    console.error('[vendors reinstate] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
