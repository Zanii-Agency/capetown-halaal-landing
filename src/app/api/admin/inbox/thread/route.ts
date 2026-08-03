/**
 * GET /api/admin/inbox/thread?thread_id=...
 *
 * Returns the thread header + a chronological message list. Used by both the
 * three-pane inbox detail view and the standalone /admin/inbox/thread/...
 * page. Defensively reads wa_messages or mail_messages depending on channel.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveContact } from '@/lib/contacts/resolve'
import { hidesEftContent, stripEftMessages, laneScopeFor } from '@/lib/inbox-lane'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface ThreadMessage {
  id: string
  direction: 'in' | 'out'
  body: string
  status: string | null
  created_at: string
  subject?: string | null
  template_name?: string | null
}

// Returns the viewer's email, not just a boolean: the EFT lane check below needs
// to know WHO is reading (only the EFT admin may open a lane vendor's thread).
async function requireAdmin(): Promise<{ ok: boolean; email: string | null }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, email: null }
  const admin = createAdminClient()
  const { data } = await admin.from('admin_users').select('id').eq('id', user.id).limit(1)
  return { ok: !!data && data.length > 0, email: user.email ?? null }
}

export async function GET(req: Request) {
  const viewer = await requireAdmin()
  if (!viewer.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const threadId = url.searchParams.get('thread_id')
  const channelParam = url.searchParams.get('channel') as 'wa' | 'mail' | null
  const keyParam = url.searchParams.get('key')

  if (!threadId && !(channelParam && keyParam)) {
    return NextResponse.json(
      { error: 'thread_id OR (channel + key) required' },
      { status: 400 }
    )
  }

  const supabase = createAdminClient()

  let query = supabase
    .from('wa_threads')
    .select(
      'id, thread_key, channel, status, last_inbound_at, last_handled_at'
    )
    .limit(1)
  if (threadId) {
    query = query.eq('id', threadId)
  } else if (channelParam && keyParam) {
    query = query.eq('channel', channelParam).eq('thread_key', keyParam)
  }

  const { data: threadRows } = (await query) as unknown as {
    data: Array<{
      id: string
      thread_key: string
      channel: 'wa' | 'mail'
      status: string
      last_inbound_at: string | null
      last_handled_at: string | null
    }> | null
  }

  if (!threadRows || threadRows.length === 0) {
    return NextResponse.json({ error: 'thread not found' }, { status: 404 })
  }
  const thread = threadRows[0]

  // TWO layers (2026-07-26): vendor, then content.
  const scope = await laneScopeFor(viewer.email)
  const outOfScope = thread.channel === 'wa'
    ? scope.blocksPhone(thread.thread_key)
    : scope.blocksEmail(thread.thread_key)
  if (outOfScope) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const hide = hidesEftContent(viewer.email)

  let messages: ThreadMessage[] = []
  if (thread.channel === 'wa') {
    const { data } = (await supabase
      .from('wa_messages')
      .select('id, direction, body, status, created_at, template_name')
      .eq('wa_phone', thread.thread_key.replace(/^\+/, ''))
      .order('created_at', { ascending: true })
      .limit(200)) as unknown as {
      data: Array<{
        id: string
        direction: string
        body: string | null
        status: string | null
        created_at: string
        template_name: string | null
      }> | null
    }
    messages = (data ?? []).map((m) => ({
      id: m.id,
      direction: m.direction === 'out' ? 'out' : 'in',
      body: m.body ?? '',
      status: m.status,
      created_at: m.created_at,
      template_name: m.template_name,
    }))
  } else {
    const { data } = (await supabase
      .from('mail_messages')
      .select('id, direction, body, subject, delivery_status, received_at')
      .eq('thread_id', thread.id)
      .order('received_at', { ascending: true })
      .limit(200)) as unknown as {
      data: Array<{
        id: string
        direction: string
        body: string | null
        subject: string | null
        delivery_status: string | null
        received_at: string
      }> | null
    }
    messages = (data ?? []).map((m) => ({
      id: m.id,
      direction: m.direction === 'outbound' ? 'out' : 'in',
      body: m.body ?? '',
      subject: m.subject,
      status: m.delivery_status,
      created_at: m.received_at,
    }))
  }

  let displayName = thread.thread_key
  try {
    const resolved = await resolveContact({
      supabase,
      waPhone: thread.channel === 'wa' ? thread.thread_key : null,
      email: thread.channel === 'mail' ? thread.thread_key : null,
    })
    displayName = resolved.displayName
  } catch {
    // best-effort; fall back to thread_key
  }

  return NextResponse.json({
    ok: true,
    thread: {
      id: thread.id,
      channel: thread.channel,
      thread_key: thread.thread_key,
      displayName,
      status: thread.status,
      last_inbound_at: thread.last_inbound_at,
      last_handled_at: thread.last_handled_at,
    },
    // Owner cutoff, same rule as everywhere else: a handed-over vendor's later
    // conversation is master-first.
    messages: stripEftMessages(messages, (m) => `${(m as { subject?: string | null }).subject || ''}\n${m.body}`, hide, {
      scope,
      identity: thread.channel === 'wa' ? { phone: thread.thread_key } : { email: thread.thread_key },
      at: (m) => (m as { at?: string; created_at?: string }).at || (m as { created_at?: string }).created_at,
    }),
  })
}
