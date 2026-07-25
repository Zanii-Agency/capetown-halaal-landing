import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { laneScopeFor } from '@/lib/inbox-lane'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { data: app } = await db
    .from('vendor_applications')
    .select('*')
    .eq('id', id)
    .single()
  if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // EFT lane: returns the full vendor row plus every WhatsApp and email body, keyed
  // by a path param anyone can type. The richest single payload of the lot.
  const scope = await laneScopeFor(user.email)
  if (scope.blocksApplicationId(id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const a = app as Record<string, unknown>
  const phoneRaw = ((a.phone as string) || '').trim()
  const emailRaw = ((a.email as string) || '').trim().toLowerCase()
  const portal = parsePortalState((a.admin_notes as string) || '')
  const { stall } = parseAllocation((a.admin_notes as string) || '')

  const digits = phoneRaw.replace(/[^0-9]/g, '')
  const last9 = digits.slice(-9)

  const [waRes, threadsRes, eventsRes] = await Promise.all([
    last9.length >= 9
      ? db.from('wa_messages').select('*').filter('wa_phone', 'like', `%${last9}`).order('created_at', { ascending: false }).limit(200)
      : Promise.resolve({ data: [] }),
    emailRaw
      ? db.from('support_inbox_threads').select('id, peer_email, peer_name, subject').ilike('peer_email', emailRaw).limit(20)
      : Promise.resolve({ data: [] }),
    db.from('vendor_application_events').select('*').eq('application_id', id).order('created_at', { ascending: false }).limit(100),
  ])

  const threadIds = ((threadsRes.data || []) as Array<{ id: string }>).map((t) => t.id)
  let supportMessages: unknown[] = []
  if (threadIds.length) {
    const { data: msgs } = await db
      .from('support_inbox_messages')
      .select('*')
      .in('thread_id', threadIds)
      .order('received_at', { ascending: false })
      .limit(500)
    supportMessages = msgs || []
  }

  const communications: CommItem[] = []

  for (const m of (waRes.data || []) as Array<{
    id: string; direction: string; body: string | null; created_at: string
    wa_phone: string; template_name: string | null; status: string | null
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

  return NextResponse.json({
    vendor: a,
    stall,
    portal,
    communications,
    events: (eventsRes.data || []),
    stats,
  })
}
