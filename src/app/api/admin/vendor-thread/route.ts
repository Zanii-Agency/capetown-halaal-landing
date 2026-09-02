import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { toE164 } from '@/lib/whatsapp'
import { hidesEftContent, stripEftMessages, laneScopeFor } from '@/lib/inbox-lane'

export const runtime = 'nodejs'

// GET /api/admin/vendor-thread?phone=0817534892
// Returns the full wa_messages thread (in+out) for the given phone, oldest
// first. Admin-only. Used by the Messages tab on /admin/vendors/[id].
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).single()
  if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const phone = (req.nextUrl.searchParams.get('phone') || '').trim()
  if (!phone) return NextResponse.json({ error: 'phone required' }, { status: 400 })
  const e164 = toE164(phone)
  const waPhone = e164.replace(/^\+/, '')

  // TWO layers (2026-07-26). Vendor: the festival owner may only open threads of
  // vendors she owns (paid via Yoco/cash/waived). Content: within those, any
  // message that talks about EFT is still stripped.
  const scope = await laneScopeFor(user.email)
  if (scope.blocksPhone(e164)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const hide = hidesEftContent(user.email)

  const { data, error } = await admin
    .from('wa_messages')
    .select('id, direction, wa_phone, template_name, category, body, status, error, provider_message_id, created_at')
    .eq('wa_phone', waPhone)
    .order('created_at', { ascending: true })
    .limit(500)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const messages = stripEftMessages(data, (m) => m.body, hide, {
    scope, identity: { phone }, at: (m) => (m as { at?: string; created_at?: string }).at || (m as { created_at?: string }).created_at,
  })
  return NextResponse.json({ phone: waPhone, count: messages.length, messages })
}
