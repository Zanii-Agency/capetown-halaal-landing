// Admin reply into a vendor support thread. Appends a {from:'admin'} message
// to that vendor's PORTAL marker support[] array, where the vendor sees it
// next time they open /exhibitor/portal/support.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, type SupportMessage } from '@/lib/portal-state'
import { requireOperator } from '@/lib/admin-rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response

  const db = createAdminClient()

  const { id: applicationId } = await params
  const body = await req.json().catch(() => ({}))
  const text = String(body.body || '').trim().slice(0, 2000)
  if (!text) return NextResponse.json({ ok: false, error: 'Message is empty' }, { status: 400 })

  const { data: app } = await db
    .from('vendor_applications')
    .select('id')
    .eq('id', applicationId)
    .maybeSingle()
  if (!app) return NextResponse.json({ ok: false, error: 'Vendor not found' }, { status: 404 })

  const msg: SupportMessage = { id: `${Date.now()}-a`, from: 'admin', body: text, at: new Date().toISOString() }
  const next = await updatePortalState(applicationId, (s) => ({
    ...s,
    support: [...(s.support || []), msg],
  }))
  return NextResponse.json({ ok: true, messages: next.support })
}
