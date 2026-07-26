/**
 * GET /api/admin/support-inbox/sent
 *
 * Returns the operator's outbound mail from support_inbox_messages where
 * direction='out'. Used by the Support Inbox Sent tab so Samreen can see what
 * was sent, by whom, when, and to which peer.
 *
 * Sort: sent_at DESC (received_at column stores both inbound + outbound time
 * per migration 20260614_support_inbox.sql).
 * Limit: 100 — enough for one operator's recent week without paginating yet.
 *
 * Auth: same admin_users gate as siblings (threads/operators/canned). Returns
 * 401 anon, 403 if signed in but not admin, 500 on db error.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hidesEftContent, stripEftMessages } from '@/lib/inbox-lane'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface SentRow {
  id: string
  thread_id: string
  to_address: string
  subject: string | null
  body_text: string | null
  received_at: string
  provider: string | null
  sent_by: string | null
}

interface ThreadRow {
  id: string
  peer_email: string
  peer_name: string | null
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { data: rows, error } = await db
    .from('support_inbox_messages')
    .select('id, thread_id, to_address, subject, body_text, received_at, provider, sent_by')
    .eq('direction', 'out')
    .order('received_at', { ascending: false })
    .limit(100)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // CONTENT-level (2026-07-26): outbound mail to a lane vendor is ordinary work
  // and stays visible; only the messages that talk about EFT are withheld.
  const sentRows = stripEftMessages(
    (rows ?? []) as SentRow[],
    (r) => `${r.subject || ''}\n${r.body_text || ''}`,
    hidesEftContent(user.email),
  )
  const threadIds = Array.from(new Set(sentRows.map((r) => r.thread_id)))

  let threadsById: Record<string, ThreadRow> = {}
  if (threadIds.length) {
    const { data: threads } = await db
      .from('support_inbox_threads')
      .select('id, peer_email, peer_name')
      .in('id', threadIds)
    threadsById = ((threads ?? []) as ThreadRow[]).reduce<Record<string, ThreadRow>>((acc, t) => {
      acc[t.id] = t
      return acc
    }, {})
  }

  const sent = sentRows.map((r) => {
    const thread = threadsById[r.thread_id] || null
    const preview = (r.body_text || '').slice(0, 240)
    return {
      id: r.id,
      thread_id: r.thread_id,
      to_address: r.to_address,
      peer_name: thread?.peer_name ?? null,
      peer_email: thread?.peer_email ?? r.to_address,
      subject: r.subject,
      preview,
      sent_at: r.received_at,
      provider: r.provider,
      sent_by: r.sent_by,
    }
  })

  return NextResponse.json({ sent })
}
