/**
 * GET /api/admin/support-inbox/threads
 *
 * Returns every support_inbox_threads row plus its messages. Filtered by
 * status query param (open | snoozed | resolved | all). Default open.
 * Tag filter optional.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hidesEftContent, stripEftMessages } from '@/lib/inbox-lane'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const url = new URL(req.url)
  const status = (url.searchParams.get('status') || 'open').toLowerCase()
  const tag = url.searchParams.get('tag')

  let q = db
    .from('support_inbox_threads')
    .select('id, peer_email, peer_name, subject, status, snoozed_until, assignee_id, tag, vendor_application_id, ticket_buyer_id, last_inbound_at, last_handled_at, unread_count, created_at, updated_at')
    .order('last_inbound_at', { ascending: false, nullsFirst: false })
    // Bumped from 200 to 1000 so openSentAsThread can find older threads when
    // an operator clicks a Sent row whose thread is no longer in the recent
    // window. Threads payload is small (~16 cols, no body), 1000 rows is fine.
    .limit(1000)

  if (status !== 'all') q = q.eq('status', status)
  if (tag) q = q.eq('tag', tag)

  const { data: threadRows, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // CONTENT-level (2026-07-26): this route returns every thread plus every message
  // body. Threads themselves are ordinary work and stay visible; the individual
  // messages that talk about EFT are stripped below, after they are fetched.
  const hide = hidesEftContent(user.email)
  const threads = threadRows || []

  const ids = (threads || []).map((t: { id: string }) => t.id)
  let messagesByThread: Record<string, unknown[]> = {}
  if (ids.length) {
    const { data: messages } = await db
      .from('support_inbox_messages')
      .select('id, thread_id, direction, from_address, from_name, to_address, subject, body_text, body_html, received_at, sent_by, provider')
      .in('thread_id', ids)
      .order('received_at', { ascending: true })
      .limit(2000)
    const visible = stripEftMessages(
      messages as Array<{ thread_id: string; subject: string | null; body_text: string | null }> | null,
      (m) => `${m.subject || ''}\n${m.body_text || ''}`,
      hide,
    )
    messagesByThread = visible.reduce((acc: Record<string, unknown[]>, m: { thread_id: string }) => {
      const tid = m.thread_id
      if (!acc[tid]) acc[tid] = []
      acc[tid].push(m)
      return acc
    }, {})
  }

  return NextResponse.json({
    threads: (threads || []).map((t: { id: string }) => ({
      ...t,
      messages: messagesByThread[t.id] || [],
    })),
  })
}
