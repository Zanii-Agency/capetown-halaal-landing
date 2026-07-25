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
import { laneScopeFor } from '@/lib/inbox-lane'

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

  // EFT lane: this route takes NO vendor identifier and returns every thread plus
  // every message body, so it was the widest door of all — a non-EFT admin did not
  // even need to guess an id. Drop lane vendors' threads BEFORE their messages are
  // fetched, matching what the unified inbox shows.
  const scope = await laneScopeFor(user.email)
  const threads = (threadRows || []).filter(
    (t: { peer_email: string | null; vendor_application_id: string | null }) =>
      !scope.blocks({ email: t.peer_email, applicationId: t.vendor_application_id }),
  )

  const ids = (threads || []).map((t: { id: string }) => t.id)
  let messagesByThread: Record<string, unknown[]> = {}
  if (ids.length) {
    const { data: messages } = await db
      .from('support_inbox_messages')
      .select('id, thread_id, direction, from_address, from_name, to_address, subject, body_text, body_html, received_at, sent_by, provider')
      .in('thread_id', ids)
      .order('received_at', { ascending: true })
      .limit(2000)
    messagesByThread = (messages || []).reduce((acc: Record<string, unknown[]>, m: { thread_id: string }) => {
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
