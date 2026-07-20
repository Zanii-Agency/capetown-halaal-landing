// Admin-triggered: ask a vendor to upload outstanding documents.
// Sends the Meta-approved vendor_document_request WhatsApp template + a
// matching email so the vendor sees the same ask in both channels.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendTemplate, toE164 } from '@/lib/whatsapp'
import { sendEmail } from '@/lib/email/resend'
import { assertRole } from '@/lib/admin-rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  // Role gate: requesting documents sends a live WhatsApp + email — owner/operator only.
  try {
    await assertRole(user.id, ['owner', 'operator'])
  } catch {
    return NextResponse.json({ ok: false, error: 'insufficient_role' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const docs: string[] = Array.isArray(body.docs) ? body.docs.slice(0, 10).map((d: unknown) => String(d).trim()).filter(Boolean) : []
  if (docs.length === 0) {
    return NextResponse.json({ ok: false, error: 'Provide at least one document name (docs: string[])' }, { status: 400 })
  }

  const { data: app } = await db
    .from('vendor_applications')
    .select('business_name, contact_name, email, phone')
    .eq('id', id)
    .single()
  if (!app) return NextResponse.json({ ok: false, error: 'Application not found' }, { status: 404 })

  const firstName = String(app.contact_name || '').trim().split(/\s+/)[0] || 'there'
  const docsList = docs.map((d) => `• ${d}`).join('\n')

  let waSent = false, emailSent = false, waSkipped: string | undefined
  if (app.phone) {
    try {
      const res = await sendTemplate(toE164(app.phone as string), 'vendor_document_request', [firstName, docsList], { category: 'utility' })
      waSent = !res.skipped
      waSkipped = res.skipped
    } catch (e) {
      console.error('[request-documents] WA failed:', (e as Error).message)
    }
  }
  try {
    const subject = `Outstanding documents for ${app.business_name}, YAH 2026`
    const text = `Hi ${firstName},\n\nTo finalise your stall at the Young at Heart Festival 2026, we still need the following from you:\n\n${docs.map((d) => '- ' + d).join('\n')}\n\nPlease upload these in your exhibitor portal at https://cthalaal.co.za/exhibitor/portal/documents, or reply to this email to send them through.\n\nFood stalls cannot be confirmed without a valid halaal certificate (COA).\n\nThanks,\nThe YAH Festival Team`
    const res = await sendEmail({ to: app.email as string, subject, text })
    emailSent = res.ok
  } catch (e) {
    console.error('[request-documents] email failed:', (e as Error).message)
  }

  return NextResponse.json({ ok: true, waSent, emailSent, waSkipped, docs })
}
