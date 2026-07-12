// Unified inbox list — merges ALL three legacy inboxes (Customer + Bot +
// Support) into ONE conversation list. A conversation = a CONTACT (person),
// keyed by phone and/or email. Built at query time with NO dependency on
// wa_threads (doesn't exist in this prod DB, DDL blocked, Law 8):
//   - WhatsApp + Bot: aggregate wa_messages by wa_phone (the bot logs here too).
//   - Email/Support: support_inbox_threads by peer_email.
//   - Resolve each phone/email to a vendor_application so a vendor's WhatsApp
//     and email collapse into ONE row.
// Status / star / assignee come from vendor_tickets + support_inbox_threads
// (the only rows we can write without DDL). Unread is derived from the latest
// message direction for WhatsApp and from thread.unread_count for email.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Contact {
  id: string                 // synthetic: vendor:<id> | wa:<phone> | mail:<email>
  business_name: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  channels: Array<'whatsapp' | 'email'>
  identity: 'vendor' | 'ticket_buyer' | 'unknown'
  last_message_at: string | null
  last_preview: string | null
  last_direction: 'in' | 'out' | null
  unread: boolean
  read_at: string | null     // WhatsApp read marker; unread iff last inbound > read_at
  starred: boolean
  tag: string | null         // operational label: payment | load-in | badges | …
  assignee_id: string | null
  application_id: string | null
  status: string             // open | snoozed | resolved
  bot_paused: boolean        // WhatsApp: true = human handling, bot is off
}

const norm = (p: string) => p.replace(/^\+/, '')
// tag column is pipe-encoded: "starred", "payment", or "starred|payment".
function parseTag(v: string | null): { starred: boolean; tag: string | null } {
  const parts = (v || '').split('|').map((s) => s.trim()).filter(Boolean)
  return { starred: parts.includes('starred'), tag: parts.find((p) => p !== 'starred') || null }
}
// Skip bracket markers, handover flags, AND internal owner-notification alerts
// (the notifyOwners "🛎️ …" system messages) so the customer inbox shows real
// conversations, not our own internal pings.
const isMarker = (b: string) => /^\s*\[[A-Z_]+\]/.test(b) || /HUMAN_HANDOVER/.test(b) || /^\s*🛎/u.test(b)
// Conversation-list preview label for a media-only message, so the list shows
// "📷 Photo" / "📎 Document" / "🎙 Voice note" instead of the bare "[no text]"
// fallback. Mirrors the kinds the webhook captures into metadata.media.kind.
function mediaPreviewLabel(kind: string | undefined): string | null {
  switch (kind) {
    case 'image': return '📷 Photo'
    case 'document': return '📎 Document'
    case 'audio': return '🎙 Voice note'
    case 'video': return '🎬 Video'
    case 'sticker': return '😊 Sticker'
    default: return null
  }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const url = new URL(req.url)
  const channelFilter = (url.searchParams.get('channel') || 'all') as 'all' | 'whatsapp' | 'email'
  const q = (url.searchParams.get('q') || '').trim().toLowerCase()

  // ---- Resolution maps: phone -> vendor, email -> vendor ----
  const { data: apps } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, phone, email')
    .limit(2000)
  const byPhone = new Map<string, { id: string; business_name: string | null; contact_name: string | null; email: string | null }>()
  const byEmail = new Map<string, { id: string; business_name: string | null; contact_name: string | null; phone: string | null }>()
  for (const a of (apps || []) as Array<{ id: string; business_name: string | null; contact_name: string | null; phone: string | null; email: string | null }>) {
    if (a.phone) byPhone.set(norm(a.phone), { id: a.id, business_name: a.business_name, contact_name: a.contact_name, email: a.email })
    if (a.email) byEmail.set(a.email.toLowerCase(), { id: a.id, business_name: a.business_name, contact_name: a.contact_name, phone: a.phone })
  }

  // ---- Conversation state from vendor_tickets (status/star/assignee/unread) ----
  const { data: tickets } = await db
    .from('vendor_tickets')
    .select('vendor_application_id, ticket_buyer_email, status, tag, assigned_to, unread_count, read_at')
  interface TState { status: string; starred: boolean; tag: string | null; assignee: string | null; unread: number; read_at: string | null }
  const tByApp = new Map<string, TState>()
  const tByEmail = new Map<string, TState>()
  for (const t of (tickets || []) as Array<{ vendor_application_id: string | null; ticket_buyer_email: string | null; status: string | null; tag: string | null; assigned_to: string | null; unread_count: number | null; read_at: string | null }>) {
    const pt = parseTag(t.tag)
    const st: TState = { status: t.status || 'open', starred: pt.starred, tag: pt.tag, assignee: t.assigned_to, unread: t.unread_count || 0, read_at: t.read_at || null }
    if (t.vendor_application_id) tByApp.set(t.vendor_application_id, st)
    if (t.ticket_buyer_email) tByEmail.set(t.ticket_buyer_email.toLowerCase(), st)
  }

  // Bot handover state per normalized phone (true = bot paused, human handling).
  const handoverPaused = new Map<string, boolean>()

  // Contacts keyed by a stable conversation key (vendor id if resolved, else
  // the raw phone/email) so a vendor's WhatsApp + email merge into one.
  const contacts = new Map<string, Contact>()
  const keyFor = (vendorId: string | null, phone: string | null, email: string | null) =>
    vendorId ? `vendor:${vendorId}` : phone ? `wa:${norm(phone)}` : `mail:${(email || '').toLowerCase()}`

  function touch(
    c: Partial<Contact> & { phone?: string | null; email?: string | null },
    at: string | null,
    preview: string,
    direction: 'in' | 'out' | null,
    channel: 'whatsapp' | 'email',
  ) {
    const phone = c.phone || null
    const email = c.email || null
    const vendorId = c.application_id || null
    const key = keyFor(vendorId, phone, email)
    const existing = contacts.get(key)
    if (!existing) {
      contacts.set(key, {
        id: key,
        business_name: c.business_name || null,
        contact_name: c.contact_name || null,
        phone, email,
        channels: [channel],
        identity: c.identity || 'unknown',
        last_message_at: at,
        last_preview: preview.slice(0, 120),
        last_direction: direction,
        unread: false,
        read_at: c.read_at ?? null,
        starred: c.starred || false,
        tag: c.tag || null,
        assignee_id: c.assignee_id || null,
        application_id: vendorId,
        status: c.status || 'open',
        bot_paused: false,
      })
    } else {
      if (!existing.channels.includes(channel)) existing.channels.push(channel)
      if (phone && !existing.phone) existing.phone = phone
      if (email && !existing.email) existing.email = email
      if (c.business_name && !existing.business_name) existing.business_name = c.business_name
      if (c.read_at && !existing.read_at) existing.read_at = c.read_at
      if (c.starred) existing.starred = true
      if (c.tag && !existing.tag) existing.tag = c.tag
      if (c.assignee_id && !existing.assignee_id) existing.assignee_id = c.assignee_id
      if (at && (!existing.last_message_at || new Date(at) > new Date(existing.last_message_at))) {
        existing.last_message_at = at
        existing.last_preview = preview.slice(0, 120)
        existing.last_direction = direction
      }
    }
  }

  // ---- WhatsApp + Bot: aggregate wa_messages by phone ----
  // ALWAYS runs, even when channelFilter narrows the returned list to one
  // channel below. counts.whatsapp/email must reflect the TRUE cross-channel
  // totals, not whatever channel happened to be selected when this request
  // fired — otherwise switching to the Email tab makes the WhatsApp tab lie
  // and show 0 (found 2026-07-12: contacts only ever got a 'whatsapp' entry
  // in this now-removed `if` branch, so filtering to Email genuinely built a
  // whatsapp-free contacts map and counts.whatsapp read 0 correctly off
  // WRONG input, not a data problem).
  {
    const { data: wa } = await db
      .from('wa_messages')
      .select('wa_phone, direction, body, created_at, metadata')
      .order('created_at', { ascending: false })
      .limit(3000)
    const seenPhone = new Set<string>()
    // Bot handover state: the FIRST [HUMAN_HANDOVER_ON/OFF] marker we see per
    // phone is the latest (rows are created_at DESC). ON => bot paused, a human
    // is handling; OFF => bot auto-replying.
    const handoverSeen = new Set<string>()
    for (const m of (wa || []) as Array<{ wa_phone: string; direction: string; body: string | null; created_at: string; metadata: { media?: { kind?: string } } | null }>) {
      const phone = norm(m.wa_phone || '')
      if (!phone) continue
      const raw = (m.body || '').trim()
      if (!handoverSeen.has(phone)) {
        if (/^\[HUMAN_HANDOVER_ON\]/.test(raw)) { handoverPaused.set(phone, true); handoverSeen.add(phone) }
        else if (/^\[HUMAN_HANDOVER_OFF\]/.test(raw)) { handoverPaused.set(phone, false); handoverSeen.add(phone) }
      }
      if (isMarker(raw)) continue
      // Strip a leading lowercase template tag (e.g. "[vendor_payment_confirmation] …")
      // so the preview reads as the actual message, not the tag. When the message
      // is media with no caption, show a media label ("📷 Photo") instead of the
      // bare "[no text]" fallback so the operator can see what the vendor sent.
      const stripped = raw.replace(/^\s*\[[a-z0-9_]+\]\s*/, '')
      const mediaLabel = mediaPreviewLabel(m.metadata?.media?.kind)
      const body = (stripped || mediaLabel || '[no text]')
      const vendor = byPhone.get(phone)
      const appId = vendor?.id || null
      const st = appId ? tByApp.get(appId) : undefined
      const isFirst = !seenPhone.has(phone)
      seenPhone.add(phone)
      touch(
        {
          phone: `+${phone}`,
          email: vendor?.email || null,
          business_name: vendor?.business_name || null,
          contact_name: vendor?.contact_name || null,
          application_id: appId,
          identity: appId ? 'vendor' : 'unknown',
          status: st?.status || 'open',
          starred: st?.starred || false,
          tag: st?.tag || null,
          assignee_id: st?.assignee || null,
          read_at: st?.read_at ?? null,
        },
        isFirst ? m.created_at : null,
        isFirst ? (body || '[no text]') : '',
        isFirst ? (m.direction === 'in' ? 'in' : 'out') : null,
        'whatsapp',
      )
    }
  }

  // ---- Email/Support: support_inbox_threads by peer_email ----
  // ALWAYS runs too — same reasoning as the WhatsApp block above.
  {
    const { data: threads } = await db
      .from('support_inbox_threads')
      .select('peer_email, peer_name, subject, status, tag, assignee_id, last_handled_at, last_inbound_at, unread_count, created_at')
      .order('last_handled_at', { ascending: false, nullsFirst: false })
      .limit(1500)
    for (const t of (threads || []) as Array<{ peer_email: string; peer_name: string | null; subject: string | null; status: string | null; tag: string | null; assignee_id: string | null; last_handled_at: string | null; last_inbound_at: string | null; unread_count: number | null; created_at: string }>) {
      const email = (t.peer_email || '').toLowerCase()
      if (!email) continue
      const vendor = byEmail.get(email)
      const appId = vendor?.id || null
      const st = appId ? tByApp.get(appId) : tByEmail.get(email)
      const at = t.last_handled_at || t.last_inbound_at || t.created_at
      touch(
        {
          email,
          phone: vendor?.phone || null,
          business_name: vendor?.business_name || null,
          contact_name: t.peer_name || vendor?.contact_name || null,
          application_id: appId,
          identity: appId ? 'vendor' : (tByEmail.has(email) ? 'ticket_buyer' : 'unknown'),
          status: st?.status || t.status || 'open',
          starred: st?.starred || parseTag(t.tag).starred,
          tag: st?.tag || parseTag(t.tag).tag,
          assignee_id: st?.assignee || t.assignee_id || null,
        },
        at,
        t.subject || '[email]',
        // threads don't carry per-message direction here; treat unread_count as the signal
        (t.unread_count || 0) > 0 ? 'in' : 'out',
        'email',
      )
    }
  }

  // Server-side search: pull matching vendors in even if their last message is
  // older than the recency scan above, so search finds the whole base, not just
  // the most-recent 500. They sort to the bottom (no recent message) but appear.
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`
    const { data: matched } = await db
      .from('vendor_applications')
      .select('id, business_name, contact_name, phone, email')
      .or(`business_name.ilike.${like},contact_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
      .limit(50)
    for (const a of (matched || []) as Array<{ id: string; business_name: string | null; contact_name: string | null; phone: string | null; email: string | null }>) {
      const st = tByApp.get(a.id)
      touch(
        {
          phone: a.phone ? `+${norm(a.phone)}` : null,
          email: a.email,
          business_name: a.business_name,
          contact_name: a.contact_name,
          application_id: a.id,
          identity: 'vendor',
          status: st?.status || 'open',
          starred: st?.starred || false,
          tag: st?.tag || null,
          assignee_id: st?.assignee || null,
        },
        null,
        a.business_name || a.contact_name || '(no messages yet)',
        null,
        a.phone ? 'whatsapp' : 'email',
      )
    }
  }

  // Phone-keyed WhatsApp read markers — persist "read" for EVERY WhatsApp thread
  // (vendor or not). digits-only key, matching the contact's phone digits.
  const waRead = new Map<string, string>()
  {
    const { data: wr } = await db.from('wa_read_state').select('wa_phone, read_at')
    for (const r of (wr || []) as Array<{ wa_phone: string; read_at: string }>) {
      waRead.set(r.wa_phone.replace(/\D/g, ''), r.read_at)
    }
  }

  // Derive unread: the latest message is inbound AND it arrived AFTER the thread
  // was last marked read. read_at comes from the phone-keyed wa_read_state for
  // WhatsApp (works for all threads), falling back to the vendor_tickets read_at.
  // So "mark read" clears the badge AND a newer inbound message re-flags it.
  // Email keeps its behaviour (last_direction set from unread_count above).
  const list = Array.from(contacts.values()).map((c) => {
    const phoneDigits = c.phone ? c.phone.replace(/\D/g, '') : ''
    const readAt = (phoneDigits && waRead.get(phoneDigits)) || c.read_at
    return {
      ...c,
      read_at: readAt,
      unread:
        c.last_direction === 'in' &&
        (!readAt || !c.last_message_at || new Date(c.last_message_at) > new Date(readAt)),
      bot_paused: c.phone ? (handoverPaused.get(norm(c.phone)) ?? false) : false,
    }
  })
  list.sort((a, b) => +new Date(b.last_message_at || 0) - +new Date(a.last_message_at || 0))

  // Counts are ALWAYS computed from the full cross-channel list (never the
  // channel-filtered display list below), so the tab badges stay true no
  // matter which tab is currently selected.
  const counts = {
    all: list.length,
    whatsapp: list.filter((c) => c.channels.includes('whatsapp')).length,
    email: list.filter((c) => c.channels.includes('email')).length,
    unread: list.filter((c) => c.unread).length,
  }

  const displayList = channelFilter === 'all' ? list : list.filter((c) => c.channels.includes(channelFilter))

  return NextResponse.json({ contacts: displayList.slice(0, 500), counts })
}
