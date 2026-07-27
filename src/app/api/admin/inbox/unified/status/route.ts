// Unified inbox conversation actions — resolve / snooze / reopen / read /
// unread / star / unstar / assign / tag / untag. Persists to the rows that
// already exist for a contact: vendor_tickets (keyed by vendor_application_id
// or ticket_buyer_email) and support_inbox_threads (keyed by peer_email). No
// wa_threads, no DDL (CTH-DOCTRINE law 8).
//
// The `tag` column has no spare sibling for the star flag, so star + an
// operational tag (payment/load-in/badges/contract/refund/general) are
// pipe-encoded together, e.g. "starred|payment". Read-modify-write keeps both.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertRole } from '@/lib/admin-rbac'
import { parseTag, encodeTag, INBOX_TAGS as TAGS } from '@/lib/inbox/tag-state'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ACTIONS = ['resolve', 'snooze', 'reopen', 'read', 'unread', 'star', 'unstar', 'assign', 'tag', 'untag'] as const
export { INBOX_TAGS } from '@/lib/inbox/tag-state'

const bodySchema = z.object({
  action: z.enum(ACTIONS),
  applicationId: z.string().uuid().optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(160).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  snoozeUntil: z.string().datetime().optional(),
  tag: z.enum(TAGS).optional(),
})

// The codec moved to @/lib/inbox/tag-state so the thread LOADERS can decode what
// this route writes. While it lived here privately, stars were written and never
// read back, so nobody ever saw one.

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Role gate: changing conversation state is a mutation — owner/operator only.
  try {
    await assertRole(user.id, ['owner', 'operator'])
  } catch {
    return NextResponse.json({ error: 'insufficient_role' }, { status: 403 })
  }

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'invalid body', details: e.issues }, { status: 400 })
    throw e
  }
  const { action } = body
  const email = body.email?.toLowerCase()
  const tagAction = action === 'star' || action === 'unstar' || action === 'tag' || action === 'untag'

  // Non-tag column patches (status / unread / assignee).
  const ticketPatch: Record<string, unknown> = {}
  const threadPatch: Record<string, unknown> = {}
  if (action === 'resolve') { ticketPatch.status = 'resolved'; threadPatch.status = 'resolved' }
  else if (action === 'reopen') { ticketPatch.status = 'open'; threadPatch.status = 'open'; threadPatch.snoozed_until = null }
  else if (action === 'snooze') {
    ticketPatch.status = 'snoozed'; threadPatch.status = 'snoozed'
    if (body.snoozeUntil) threadPatch.snoozed_until = body.snoozeUntil
  }
  // read_at is the WhatsApp-side read marker: a thread is unread only when an
  // inbound message is NEWER than read_at, so marking read clears the badge AND a
  // later inbound re-flags it. (Email already clears via unread_count.)
  else if (action === 'read') { ticketPatch.unread_count = 0; ticketPatch.read_at = new Date().toISOString(); threadPatch.unread_count = 0 }
  else if (action === 'unread') { ticketPatch.unread_count = 1; ticketPatch.read_at = null; threadPatch.unread_count = 1 }
  else if (action === 'assign') { ticketPatch.assigned_to = body.assigneeId ?? null; threadPatch.assignee_id = body.assigneeId ?? null }

  // Apply a tag-column change to an existing tag value, preserving the other half.
  const nextTag = (current: string | null): string | null => {
    const cur = parseTag(current)
    if (action === 'star') return encodeTag(true, cur.tag)
    if (action === 'unstar') return encodeTag(false, cur.tag)
    if (action === 'tag') return encodeTag(cur.starred, body.tag ?? null)
    if (action === 'untag') return encodeTag(cur.starred, null)
    return current
  }

  let touched = 0

  // ---- vendor_tickets (vendors + ticket buyers) ----
  if (body.applicationId || email) {
    let q = db.from('vendor_tickets').select('id, tag')
    if (body.applicationId) q = q.eq('vendor_application_id', body.applicationId)
    else q = q.eq('ticket_buyer_email', email!)
    const { data: existing } = await q.limit(1).maybeSingle()
    const patch = { ...ticketPatch }
    if (tagAction) patch.tag = nextTag((existing as { tag: string | null } | null)?.tag ?? null)
    if (existing?.id && Object.keys(patch).length) {
      const { error } = await db.from('vendor_tickets').update(patch).eq('id', existing.id)
      if (!error) touched++
    } else if (!existing?.id && body.applicationId && Object.keys(patch).length) {
      const { error } = await db.from('vendor_tickets').insert({
        vendor_application_id: body.applicationId,
        ticket_buyer_email: email ?? null,
        status: (patch.status as string) ?? 'open',
        ...patch,
      })
      if (!error) touched++
    }
  }

  // ---- support_inbox_threads (email side) ----
  if (email) {
    const { data: threads } = await db.from('support_inbox_threads').select('id, tag').ilike('peer_email', email)
    for (const t of (threads || []) as Array<{ id: string; tag: string | null }>) {
      const patch = { ...threadPatch }
      if (tagAction) patch.tag = nextTag(t.tag)
      if (!Object.keys(patch).length) continue
      const { error } = await db.from('support_inbox_threads').update(patch).eq('id', t.id)
      if (!error) touched++
    }
  }

  // WhatsApp read marker, phone-keyed. Works for EVERY WhatsApp thread, including
  // non-vendor / unknown numbers that have no vendor_tickets row — so "read"
  // actually persists across reloads for all of them, not just vendors.
  if (body.phone && (action === 'read' || action === 'unread')) {
    const digits = body.phone.replace(/\D/g, '')
    if (digits) {
      if (action === 'read') {
        await db.from('wa_read_state').upsert({ wa_phone: digits, read_at: new Date().toISOString() }, { onConflict: 'wa_phone' })
      } else {
        await db.from('wa_read_state').delete().eq('wa_phone', digits)
      }
      touched++
    }
  }

  return NextResponse.json({ ok: true, action, touched })
}
