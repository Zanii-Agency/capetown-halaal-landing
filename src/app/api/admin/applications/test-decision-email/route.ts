// Send a TEST decision email (reject / info-requested) to the logged-in admin's
// OWN inbox, so they can preview exactly what a vendor receives — reason and all
// — before firing the real decision. This does NOT touch the vendor: no vendor
// send, no account provisioning, no WhatsApp, no markers. It only renders the
// same template decision-notify uses and mails it to the admin.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertRole } from '@/lib/admin-rbac'
import { sendEmail } from '@/lib/email/resend'
import { ApplicationRejected } from '@/lib/email/templates/ApplicationRejected'
import { ApplicationInfoRequested } from '@/lib/email/templates/ApplicationInfoRequested'
import { cleanReason } from '@/lib/applications/decision-notify'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  status: z.enum(['rejected', 'info_requested']),
  reason: z.string().max(2000).optional(),
  businessName: z.string().max(200).optional(),
  contactName: z.string().max(200).optional(),
})

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const admin = createAdminClient()
    const { data: adminUser } = await admin
      .from('admin_users')
      .select('id, role, email')
      .eq('id', user.id)
      .single()
    if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    try {
      await assertRole(user.id, ['owner', 'operator'])
    } catch {
      return NextResponse.json({ error: 'insufficient_role' }, { status: 403 })
    }

    const to = (adminUser.email as string | null) || user.email
    if (!to) return NextResponse.json({ error: 'no admin email on file' }, { status: 400 })

    const { status, reason, businessName, contactName } = bodySchema.parse(await request.json())
    const cleaned = cleanReason(reason)
    const biz = businessName?.trim() || 'Sample Business'
    const contact = contactName?.trim() || String(to).split('@')[0] || 'there'

    const react =
      status === 'rejected'
        ? ApplicationRejected({ contactName: contact, businessName: biz, reason: cleaned || undefined })
        : ApplicationInfoRequested({ contactName: contact, businessName: biz, reason: cleaned || undefined })

    const subject =
      status === 'rejected'
        ? '[TEST] An update on your Young at Heart Festival 2026 application'
        : '[TEST] A little more information needed, Young at Heart Festival 2026'

    const res = await sendEmail({ to, subject, react })
    if (!res.ok) {
      return NextResponse.json({ error: res.error || 'send failed' }, { status: 502 })
    }
    return NextResponse.json({ success: true, sentTo: to, hadReason: !!cleaned })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    console.error('[test-decision-email] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
