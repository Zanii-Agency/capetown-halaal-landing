import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const gate = await requireOperator()
  if (!gate.ok) return gate.response

  const admin = createAdminClient()

  const body = await req.json()
  const { action, value } = body

  let updateError = null
  switch (action) {
    case 'status': {
      if (!['open', 'snoozed', 'resolved'].includes(value)) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
      }
      const { error } = await admin.from('vendor_tickets').update({ status: value, updated_at: new Date().toISOString() }).eq('id', id)
      updateError = error
      break
    }
    case 'assign': {
      const { error } = await admin.from('vendor_tickets').update({ assigned_to: value || null, updated_at: new Date().toISOString() }).eq('id', id)
      updateError = error
      break
    }
    case 'tag': {
      const { error } = await admin.from('vendor_tickets').update({ tag: value || null, updated_at: new Date().toISOString() }).eq('id', id)
      updateError = error
      break
    }
    case 'mark_read': {
      const { error } = await admin.from('vendor_tickets').update({ unread_count: 0, updated_at: new Date().toISOString() }).eq('id', id)
      updateError = error
      break
    }
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  if (updateError) {
    console.error('[vendor-tickets action] update failed:', updateError.message)
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
