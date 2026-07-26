import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hidesEftContent, stripEftMessages } from '@/lib/inbox-lane'

export const dynamic = 'force-dynamic'

interface CommItem {
  id: string
  channel: 'whatsapp' | 'email'
  direction: 'in' | 'out'
  body: string
  at: string
  from: string
  subject?: string
}

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).single()
  if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Resolve the ticket's contact identity. WhatsApp messages are linked by the
  // vendor/buyer PHONE and email by peer_email — NOT via wa_threads, whose
  // `id`/`ticket_id` columns don't exist in this Supabase (DDL blocked, Law 8).
  // The old code queried wa_threads.id and silently errored, so no WhatsApp
  // messages ever loaded here.
  const { data: ticket } = await admin
    .from('vendor_tickets')
    .select('id, vendor_application_id, ticket_buyer_email')
    .eq('id', id)
    .single()
  if (!ticket) return NextResponse.json({ messages: [] })

  let phone: string | null = null
  let email: string | null = (ticket.ticket_buyer_email as string | null) || null

  if (ticket.vendor_application_id) {
    const { data: v } = await admin
      .from('vendor_applications')
      .select('phone, email')
      .eq('id', ticket.vendor_application_id)
      .single()
    phone = (v?.phone as string | null) || null
    email = email || (v?.email as string | null) || null
  }
  if (!phone && email) {
    const { data: b } = await admin
      .from('ticket_buyers')
      .select('phone')
      .ilike('email', email)
      .maybeSingle()
    phone = (b?.phone as string | null) || null
  }

  // EFT lane: the ticket id resolves to a phone/email, so checking after
  // resolution covers both shapes regardless of which one the ticket carried.
  const hide = hidesEftContent(user.email)

  const comms: CommItem[] = []

  // ---- WhatsApp (by phone, both +27… and 27… forms) ----
  if (phone) {
    const noPlus = phone.replace(/^\+/, '')
    const { data: msgs } = await admin
      .from('wa_messages')
      .select('id, direction, body, created_at, wa_phone, template_name')
      .or(`wa_phone.eq.${phone},wa_phone.eq.${noPlus}`)
      .order('created_at', { ascending: true })
      .limit(300)

    for (const m of (msgs || []) as Array<{
      id: string; direction: string; body: string | null; created_at: string
      wa_phone: string; template_name: string | null
    }>) {
      const body = m.body || (m.template_name ? `[template: ${m.template_name}]` : '')
      if (!body) continue
      // Skip internal handover markers ([HUMAN_HANDOVER_*]) — not chat content.
      if (/^\[[A-Z_]+\]/.test(body)) continue
      comms.push({
        id: `wa:${m.id}`,
        channel: 'whatsapp',
        direction: m.direction === 'in' ? 'in' : 'out',
        body,
        at: m.created_at,
        from: m.direction === 'in' ? `+${m.wa_phone.replace(/^\+/, '')}` : 'Team',
      })
    }
  }

  // ---- Email (by peer_email on support_inbox) ----
  if (email) {
    const { data: threads } = await admin
      .from('support_inbox_threads')
      .select('id, peer_email, subject')
      .ilike('peer_email', email)

    if (threads?.length) {
      const threadIds = threads.map((t) => t.id)
      const { data: msgs } = await admin
        .from('support_inbox_messages')
        .select('id, thread_id, direction, from_address, to_address, subject, body_text, received_at')
        .in('thread_id', threadIds)
        .order('received_at', { ascending: true })
        .limit(500)

      const threadMap = new Map(threads.map((t) => [t.id, { peer_email: t.peer_email, subject: t.subject }]))
      for (const m of (msgs || []) as Array<{
        id: string; thread_id: string; direction: string; from_address: string
        to_address: string; subject: string | null; body_text: string | null; received_at: string
      }>) {
        const thread = threadMap.get(m.thread_id)
        const body = m.body_text || m.subject || ''
        if (!body) continue
        comms.push({
          id: `mail:${m.id}`,
          channel: 'email',
          direction: m.direction === 'in' ? 'in' : 'out',
          body,
          at: m.received_at,
          from: m.direction === 'in' ? m.from_address : (thread?.peer_email || 'Team'),
          subject: m.subject || thread?.subject || undefined,
        })
      }
    }
  }

  // Oldest first so the conversation reads top-to-bottom (newest at the bottom).
  comms.sort((a, b) => +new Date(a.at) - +new Date(b.at))

  return NextResponse.json({ messages: stripEftMessages(comms, (m) => m.body, hide) })
}
