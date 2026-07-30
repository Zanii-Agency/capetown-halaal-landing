import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { visiblePaymentStatus } from '@/lib/eft'
import { parseAllocation } from '@/lib/stalls'
import { hidesEftContent, stripEftMessages, laneScopeFor } from '@/lib/inbox-lane'
import { hiddenFromOwner } from '@/lib/audit-scope'
import { Vendor360 } from './Vendor360'

export const dynamic = 'force-dynamic'

interface CommItem {
  id: string
  channel: 'whatsapp' | 'email'
  direction: 'in' | 'out'
  body: string
  at: string
  from: string
  to?: string
  subject?: string
  template?: string | null
}

interface AuditEvent {
  id: string
  event_type: string
  note: string | null
  created_at: string
  actor_email: string | null
}

export default async function Vendor360Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')
  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).single()
  if (!adminUser) redirect('/admin/login')

  const { data: app } = await admin
    .from('vendor_applications')
    .select('*')
    .eq('id', id)
    .single()
  if (!app) notFound()

  const scope = await laneScopeFor(user.email)
  if (scope.blocksApplicationId(id)) redirect('/admin/vendors')
  const hide = hidesEftContent(user.email)

  const a = app as Record<string, unknown>
  const portalRaw = parsePortalState((a.admin_notes as string) || '')
  // MASK THE PAYMENT STATE FOR THE VIEWER. The vendor LIST already did this
  // (admin/vendors/page.tsx) and this detail page did not, so opening a profile
  // showed the raw state: an EFT-collected vendor read as 'collected' to the
  // festival owner, which is precisely the arrangement the master lane hides.
  // Taona 2026-07-28: "for dev@cthalaal.co.za this is correct, for samreen it
  // shouldnt be". visiblePaymentStatus collapses 'collected' to 'none' for
  // everyone except the EFT admin.
  const portal = {
    ...portalRaw,
    payment: portalRaw.payment
      ? {
          ...portalRaw.payment,
          status: visiblePaymentStatus(portalRaw.payment.status, user.email) as
            NonNullable<typeof portalRaw.payment>['status'],
        }
      : portalRaw.payment,
  }
  const { stall } = parseAllocation((a.admin_notes as string) || '')

  const phoneRaw = ((a.phone as string) || '').trim()
  const emailRaw = ((a.email as string) || '').trim().toLowerCase()
  const digits = phoneRaw.replace(/[^0-9]/g, '')
  const last9 = digits.slice(-9)

  const [waRes, threadsRes, eventsRes] = await Promise.all([
    last9.length >= 9
      ? admin.from('wa_messages').select('id, direction, body, created_at, wa_phone, template_name, status').filter('wa_phone', 'like', `%${last9}`).order('created_at', { ascending: false }).limit(200)
      : Promise.resolve({ data: [] }),
    emailRaw
      ? admin.from('support_inbox_threads').select('id, peer_email, peer_name, subject').ilike('peer_email', emailRaw).limit(20)
      : Promise.resolve({ data: [] }),
    (async () => {
      try {
        return await admin.from('vendor_application_events').select('id, event_type, note, created_at, actor_email').eq('application_id', id).order('created_at', { ascending: false }).limit(100)
      } catch {
        return { data: [] }
      }
    })(),
  ])

  const threadIds = ((threadsRes.data || []) as Array<{ id: string }>).map((t) => t.id)
  let supportMessages: unknown[] = []
  if (threadIds.length) {
    const { data: msgs } = await admin
      .from('support_inbox_messages')
      .select('id, thread_id, direction, from_address, to_address, subject, body_text, received_at')
      .in('thread_id', threadIds)
      .order('received_at', { ascending: false })
      .limit(500)
    supportMessages = msgs || []
  }

  const communications: CommItem[] = []

  for (const m of (waRes.data || []) as Array<{
    id: string; direction: string; body: string | null; created_at: string
    wa_phone: string; template_name: string | null
  }>) {
    const body = m.body || (m.template_name ? `[template: ${m.template_name}]` : '')
    if (!body) continue
    communications.push({
      id: `wa:${m.id}`,
      channel: 'whatsapp',
      direction: m.direction === 'in' ? 'in' : 'out',
      body,
      at: m.created_at,
      from: m.direction === 'in' ? `+${m.wa_phone}` : 'Admin',
      template: m.template_name,
    })
  }

  const threadMap = new Map<string, { peer_email: string; subject: string | null }>()
  for (const t of (threadsRes.data || []) as Array<{ id: string; peer_email: string; subject: string | null }>) {
    threadMap.set(t.id, { peer_email: t.peer_email, subject: t.subject })
  }
  for (const m of (supportMessages || []) as Array<{
    id: string; thread_id: string; direction: string; from_address: string
    to_address: string; subject: string | null; body_text: string | null; received_at: string
  }>) {
    const thread = threadMap.get(m.thread_id)
    const body = m.body_text || m.subject || ''
    if (!body) continue
    communications.push({
      id: `mail:${m.id}`,
      channel: 'email',
      direction: m.direction === 'in' ? 'in' : 'out',
      body,
      at: m.received_at,
      from: m.direction === 'in' ? m.from_address : (thread?.peer_email || 'Admin'),
      to: m.direction === 'out' ? m.to_address : undefined,
      subject: m.subject || thread?.subject || undefined,
    })
  }

  communications.sort((a, b) => +new Date(b.at) - +new Date(a.at))
  const visibleComms = stripEftMessages(communications, (m) => m.body, hide, {
    scope,
    identity: { phone: phoneRaw, email: emailRaw },
    at: (m) => m.at,
  })

  const events = ((eventsRes.data || []) as AuditEvent[]).filter((e) =>
    !hiddenFromOwner({ event_type: e.event_type, note: e.note }, true),
  )

  // Do not ship the internal admin_notes blob to the browser.
  const { admin_notes: _adminNotes, ...vendorSafe } = a as Record<string, unknown>

  const approvedAt = a.approved_at as string | null | undefined
  const daysSinceApproval = approvedAt
    ? Math.floor((Date.now() - new Date(approvedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null

  const stats = {
    days_since_approval: daysSinceApproval,
    document_count: (portal.docs || []).length,
    staff_count: (portal.staff || []).length,
    approved_count: (portal.docs || []).filter((d) => d.status === 'approved').length,
  }

  return (
    <Vendor360
      initialData={{
        vendor: vendorSafe,
        stall,
        portal,
        communications: visibleComms,
        events,
        stats,
      }}
    />
  )
}
