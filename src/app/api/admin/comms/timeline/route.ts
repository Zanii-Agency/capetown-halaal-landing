/**
 * GET /api/admin/comms/timeline?contactId=<uuid>&phone=<e164>&email=<lower>
 *
 * Aggregated unified timeline for one contact across:
 *   - wa_messages (matched by last-9 digits of phone, mirrors the existing
 *     vendor-thread route's matching strategy)
 *   - support_inbox_messages (matched by support_inbox_threads.peer_email
 *     case-insensitive)
 *   - vendor_applications.admin_notes (stripped of marker blocks, surfaced as
 *     a single "note" row keyed on updated_at)
 *
 * Each row is normalised to:
 *   { id, channel, direction, body, at, source, source_label, meta }
 *
 * Admin-only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hidesEftContent, stripEftMessages, laneScopeFor } from '@/lib/inbox-lane'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface TimelineRow {
  id: string
  channel: 'whatsapp' | 'email' | 'note'
  direction: 'in' | 'out' | 'note'
  body: string
  at: string
  source: string
  source_label: string
  meta?: Record<string, unknown>
}

// Strip the marker blocks (⟦STALL:..⟧, ⟦PORTAL:..⟧, ⟦DOCS:..⟧, etc.) so the
// note we surface is just human prose.
function stripMarkers(notes: string | null | undefined): string {
  if (!notes) return ''
  return notes
    .replace(/⟦STALL:[^⟧]+⟧/g, '')
    .replace(/⟦PORTAL:[^⟧]+⟧/g, '')
    .replace(/⟦DOCS:[^⟧]+⟧/g, '')
    .replace(/⟦CONTRACT_SIGNED⟧/g, '')
    .replace(/⟦PAID⟧/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const sp = new URL(req.url).searchParams
  const contactId = (sp.get('contactId') || '').trim()
  const threadId = (sp.get('threadId') || '').trim()

  // H3: NEVER accept arbitrary ?phone= / ?email= from the query. Any admin
  // session (or attacker holding one) could otherwise scrape any phone's
  // WhatsApp history. Phone + email must be resolved server-side from a
  // contactId or threadId that the caller has demonstrably scoped to.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  let phoneRaw = ''
  let emailRaw = ''

  if (contactId) {
    if (!UUID_RE.test(contactId)) {
      return NextResponse.json({ error: 'invalid contactId' }, { status: 400 })
    }
    const { data: vapp } = await db
      .from('vendor_applications')
      .select('id, phone, email')
      .eq('id', contactId)
      .maybeSingle()
    if (vapp) {
      phoneRaw = ((vapp as { phone?: string | null }).phone || '').trim()
      emailRaw = ((vapp as { email?: string | null }).email || '').trim().toLowerCase()
    }
  } else if (threadId) {
    if (!UUID_RE.test(threadId)) {
      return NextResponse.json({ error: 'invalid threadId' }, { status: 400 })
    }
    const { data: thread } = await db
      .from('wa_threads')
      .select('id, thread_key, channel')
      .eq('id', threadId)
      .maybeSingle()
    if (thread) {
      const t = thread as { thread_key?: string | null; channel?: string | null }
      if (t.channel === 'wa') phoneRaw = (t.thread_key || '').trim()
      else if (t.channel === 'mail') emailRaw = (t.thread_key || '').trim().toLowerCase()
    }
  } else {
    return NextResponse.json({ error: 'contactId or threadId required' }, { status: 400 })
  }

  // EFT lane: H3 above stops an arbitrary ?phone=, but a caller may still pass any
  // contactId/threadId, so the resolved phone/email can still belong to a lane
  // vendor. Check AFTER resolution, before the three history queries below.
  // TWO layers (2026-07-26): vendor, then content.
  const scope = await laneScopeFor(user.email)
  if (scope.blocks({ phone: phoneRaw, email: emailRaw })) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const hideEft = hidesEftContent(user.email)

  // Pagination. Default 50, max 200. Skeptic D F1: page latency was the cost
  // of serial awaits over three tables; we now parallelise and trim. Callers
  // step through history via `offset`.
  const rawLimit = Number(sp.get('limit') || '50')
  const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50))
  const rawOffset = Number(sp.get('offset') || '0')
  const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)

  // --- Build the three queries lazily, run them with Promise.all ------------
  const digits = phoneRaw.replace(/[^0-9]/g, '')
  const last9 = digits.slice(-9)

  const waQuery: Promise<{ data: unknown }> =
    phoneRaw && last9.length >= 9
      ? (db
          .from('wa_messages')
          .select('id, direction, body, created_at, template_name, status, wa_phone, error')
          .filter('wa_phone', 'like', `%${last9}`)
          .order('created_at', { ascending: false })
          .limit(200) as unknown as Promise<{ data: unknown }>)
      : Promise.resolve({ data: [] })

  const threadsQuery: Promise<{ data: unknown }> =
    emailRaw
      ? (db
          .from('support_inbox_threads')
          .select('id, peer_email, peer_name, subject')
          .ilike('peer_email', emailRaw)
          .limit(20) as unknown as Promise<{ data: unknown }>)
      : Promise.resolve({ data: [] })

  const noteQuery: Promise<{ data: unknown }> =
    contactId
      ? (db
          .from('vendor_applications')
          .select('id, admin_notes, updated_at')
          .eq('id', contactId)
          .maybeSingle() as unknown as Promise<{ data: unknown }>)
      : Promise.resolve({ data: null })

  const [waRes, threadsRes, noteRes] = await Promise.all([waQuery, threadsQuery, noteQuery])

  const rows: TimelineRow[] = []

  // -------- WhatsApp --------------------------------------------------------
  const waMsgs = (waRes?.data || []) as Array<{
    id: string
    direction: 'in' | 'out'
    body: string | null
    created_at: string
    template_name: string | null
    status: string | null
    wa_phone: string
    error: string | null
  }>
  for (const m of waMsgs) {
    const body = m.body || (m.template_name ? `[template: ${m.template_name}]` : '')
    if (!body) continue
    rows.push({
      id: `wa:${m.id}`,
      channel: 'whatsapp',
      direction: m.direction === 'in' ? 'in' : 'out',
      body,
      at: m.created_at,
      source: `wa:${m.wa_phone}`,
      source_label: `WhatsApp +${m.wa_phone}`,
      meta: {
        template_name: m.template_name || undefined,
        status: m.status || undefined,
        error: m.error || undefined,
      },
    })
  }

  // -------- Email via support_inbox -----------------------------------------
  const threads = (threadsRes?.data || []) as Array<{ id: string; peer_email: string; subject: string | null }>
  const threadIds = threads.map((t) => t.id)
  if (threadIds.length) {
    const threadMap = new Map<string, { peer_email: string; subject: string | null }>()
    for (const t of threads) {
      threadMap.set(t.id, { peer_email: t.peer_email, subject: t.subject })
    }
    const { data: msgs } = await db
      .from('support_inbox_messages')
      .select('id, thread_id, direction, from_address, to_address, subject, body_text, received_at, provider')
      .in('thread_id', threadIds)
      .order('received_at', { ascending: false })
      .limit(500)
    for (const m of (msgs || []) as Array<{
      id: string
      thread_id: string
      direction: 'in' | 'out'
      from_address: string
      to_address: string
      subject: string | null
      body_text: string | null
      received_at: string
      provider: string | null
    }>) {
      const thread = threadMap.get(m.thread_id)
      rows.push({
        id: `mail:${m.id}`,
        channel: 'email',
        direction: m.direction === 'in' ? 'in' : 'out',
        body: m.body_text || m.subject || '',
        at: m.received_at,
        source: `mail:${m.thread_id}`,
        source_label: thread?.subject ? `Email: ${thread.subject}` : `Email: ${thread?.peer_email || emailRaw}`,
        meta: {
          subject: m.subject || undefined,
          from: m.from_address,
          to: m.to_address,
          provider: m.provider || undefined,
        },
      })
    }
  }

  // -------- Admin note ------------------------------------------------------
  const app = (noteRes?.data || null) as { id: string; admin_notes: string | null; updated_at: string | null } | null
  if (app) {
    const note = stripMarkers(app.admin_notes)
    if (note) {
      rows.push({
        id: `note:${app.id}`,
        channel: 'note',
        direction: 'note',
        body: note,
        at: app.updated_at || new Date().toISOString(),
        source: `app:${app.id}`,
        source_label: 'Admin notes',
      })
    }
  }

  rows.sort((a, b) => +new Date(b.at) - +new Date(a.at))

  const total = stripEftMessages(rows, (r) => r.body, hideEft).length
  // EFT wall is CONTENT-level (2026-07-26): strip before paginating, so `total`
  // and has_more describe what the viewer can actually see rather than promising
  // rows that were then filtered away.
  const visible = stripEftMessages(rows, (r) => r.body, hideEft)
  const page = visible.slice(offset, offset + limit)
  const has_more = offset + page.length < total

  return NextResponse.json({
    rows: page,
    pagination: { limit, offset, total, has_more },
  })
}
