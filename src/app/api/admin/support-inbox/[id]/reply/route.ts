/**
 * POST /api/admin/support-inbox/[id]/reply
 *
 * Sends an outbound reply from support@youngatheart.co.za, persists the
 * message into support_inbox_messages, and marks the thread handled.
 *
 * Outbound channel = Resend (CTH doctrine Law 5: GoDaddy SMTP is for
 * confirmation emails only, Resend is the inbox-safe sender).
 *
 * Body:
 *   { body: string, subject?: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { requireOperator } from '@/lib/admin-rbac'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  const { user } = gate

  const db = createAdminClient()

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'thread id required' }, { status: 400 })

  const json = await req.json().catch(() => ({}))
  const text = String(json.body || '').trim()
  if (!text) return NextResponse.json({ error: 'body is empty' }, { status: 400 })
  const subjectOverride = json.subject ? String(json.subject).slice(0, 200) : null

  const { data: thread, error: tErr } = await db
    .from('support_inbox_threads')
    .select('id, peer_email, subject, status')
    .eq('id', id)
    .maybeSingle()
  if (tErr || !thread) return NextResponse.json({ error: tErr?.message || 'thread not found' }, { status: 404 })

  const peer = (thread as { peer_email: string }).peer_email
  const currentSubject = (thread as { subject: string | null }).subject || 'Young at Heart Festival'
  const replySubject = subjectOverride
    ? subjectOverride
    : currentSubject.toLowerCase().startsWith('re:')
      ? currentSubject
      : `Re: ${currentSubject}`

  const send = await sendEmail({ to: peer, subject: replySubject, text })
  if (!send.ok) return NextResponse.json({ error: send.error || 'send failed' }, { status: 502 })

  const nowIso = new Date().toISOString()
  const { error: msgErr } = await db.from('support_inbox_messages').insert({
    thread_id: id,
    direction: 'out',
    from_address: 'support@youngatheart.co.za',
    from_name: 'Young at Heart Festival',
    to_address: peer,
    subject: replySubject,
    body_text: text,
    provider: 'resend',
    received_at: nowIso,
    sent_by: user.id,
  })
  if (msgErr) return NextResponse.json({ error: `persist failed: ${msgErr.message}` }, { status: 500 })

  await db
    .from('support_inbox_threads')
    .update({ status: 'open', last_handled_at: nowIso, unread_count: 0 })
    .eq('id', id)

  // Mirror to site_events for the timeline.
  try {
    await db.from('site_events').insert({
      session_id: 'support-inbox',
      event_type: 'support_mail_out',
      path: '/admin/support-inbox',
      metadata: { thread_id: id, to: peer, subject: replySubject, sent_by: user.id },
    })
  } catch { /* swallow */ }

  return NextResponse.json({ ok: true })
}
