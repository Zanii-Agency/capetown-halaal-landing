/**
 * POST /api/admin/vendors/[id]/staff/[memberId]/resend
 *
 * Admin-triggered resend of a staff badge PDF to the vendor's WhatsApp.
 * Layer 3 (Law 3, FooEvents-no-fork): we never regenerate the ticket. We
 * fire the existing ticket_delivery WhatsApp template pointing at the WC
 * order URL. Sister endpoint to /api/exhibitor/staff/resend.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { sendTicket, toE164 } from '@/lib/whatsapp'
import { WP_ORIGIN } from '@/lib/woocommerce'
import { assertRole } from '@/lib/admin-rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  const { id, memberId } = await params
  if (!id || !memberId) return NextResponse.json({ error: 'id + memberId required' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, role').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Role gate: resending a staff badge sends a live WhatsApp — owner/operator only.
  try {
    await assertRole(user.id, ['owner', 'operator'])
  } catch {
    return NextResponse.json({ error: 'insufficient_role' }, { status: 403 })
  }

  const { data: appRow } = await db.from('vendor_applications')
    .select('admin_notes, business_name, contact_name, phone')
    .eq('id', id).maybeSingle()
  if (!appRow) return NextResponse.json({ error: 'vendor not found' }, { status: 404 })

  const state = parsePortalState((appRow.admin_notes as string) || '')
  const member = (state.staff || []).find((m) => m.id === memberId)
  if (!member) return NextResponse.json({ error: 'staff member not found' }, { status: 404 })
  if (!member.wc_order_id) return NextResponse.json({ error: 'badge not yet generated' }, { status: 409 })

  const e164 = toE164(String(appRow.phone || ''))
  if (!e164) return NextResponse.json({ error: 'vendor WhatsApp number missing' }, { status: 409 })

  const orderNumber = member.wc_order_number || String(member.wc_order_id)
  const pdfUrl = member.ticket_pdf_url || `${WP_ORIGIN}/wp-admin/post.php?post=${member.wc_order_id}&action=edit`
  const firstName = (String(appRow.contact_name || appRow.business_name || 'there')).split(/\s+/)[0]

  const res = await sendTicket({
    to: e164,
    firstName,
    orderNumber,
    ticketSummary: `Staff badge for ${member.name}`,
    pdfUrl,
    filename: `YAH-StaffBadge-${orderNumber}.pdf`,
  })

  try {
    await db.from('vendor_application_events').insert({
      application_id: id,
      event_type: 'staff_badge_resent',
      after_value: { staff_id: memberId, wc_order_id: member.wc_order_id },
      actor_email: user.email || null,
      actor_role: 'admin',
      note: `Resent staff badge PDF for ${member.name}`,
    })
  } catch (e) {
    console.warn('[admin/staff resend] event log failed:', (e as Error).message)
  }

  if (res.skipped) return NextResponse.json({ ok: false, skipped: res.skipped }, { status: 200 })
  return NextResponse.json({ ok: true, messageId: res.messageId })
}
