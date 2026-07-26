// Unified thread view — all messages for a CONTACT across WhatsApp + email.
// Takes the contact's phone and/or email directly (the unified list provides
// both), so it works for ticketed AND ticketless conversations. No wa_threads.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseAttachmentMarker } from '@/lib/email/attachments'
import { hidesEftContent, stripEftMessages, laneScopeFor } from '@/lib/inbox-lane'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface MediaInfo {
  kind: 'image' | 'document' | 'video' | 'audio' | 'sticker'
  // Same-origin proxy URL the client renders (img/link). Null when the row has
  // no resolvable media id (legacy media logged before capture existed).
  url: string | null
  mimeType?: string
  filename?: string
}
interface CommItem {
  id: string
  channel: 'whatsapp' | 'email'
  direction: 'in' | 'out'
  body: string
  at: string
  from: string
  subject?: string
  bot?: boolean
  // An array, not a single item: WhatsApp always sends 0 or 1 media per
  // message, but a real email can carry several attachments at once.
  media?: MediaInfo[]
}

function kindForMime(mimeType: string): MediaInfo['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'document'
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const url = new URL(req.url)
  const phone = (url.searchParams.get('phone') || '').trim()
  const email = (url.searchParams.get('email') || '').trim().toLowerCase()

  // TEMPORARY EFT lane privacy: if this contact resolves to an EFT-lane vendor,
  // ONLY the EFT admin (dev@) may read the thread. The email- and phone-resolved
  // vendors are checked INDEPENDENTLY (a crafted request can mismatch them, e.g. a
  // benign email + an EFT vendor's phone) and we block if EITHER is in the lane.
  // No .limit(1): a last-9 phone collision must not hide the lane vendor behind
  // another matching row. Seals the direct-API path completely.
  // TWO layers (2026-07-26): the owner may only open a vendor she owns, and
  // within that thread any EFT message is stripped at the bottom of this handler.
  const scope = await laneScopeFor(user.email)
  if (scope.blocks({ email, phone })) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const hide = hidesEftContent(user.email)

  const comms: CommItem[] = []
  const local = (e?: string | null) => (e ? e.split('@')[0] : null)

  // admin id -> email, to attribute email replies (support_inbox_messages.sent_by is a uuid).
  const { data: admins } = await db.from('admin_users').select('id, email')
  const adminEmailById = new Map<string, string>((admins || []).map((a: { id: string; email: string }) => [a.id, a.email]))

  // ---- WhatsApp by phone (both +27… and 27… forms) ----
  if (phone) {
    const noPlus = phone.replace(/^\+/, '')
    const { data: msgs } = await db
      .from('wa_messages')
      .select('id, direction, body, created_at, wa_phone, template_name, metadata')
      .or(`wa_phone.eq.+${noPlus},wa_phone.eq.${noPlus}`)
      .order('created_at', { ascending: true })
      .limit(400)
    for (const m of (msgs || []) as Array<{ id: string; direction: string; body: string | null; created_at: string; wa_phone: string; template_name: string | null; metadata: { sent_by?: string; via?: string; media?: { kind: 'image' | 'document' | 'video' | 'audio' | 'sticker'; id?: string; mime_type?: string; filename?: string; caption?: string } } | null }>) {
      // Internal owner-notification pings ("🛎️ …") and bracket markers are not
      // part of the customer conversation. A real inbound with no text is media.
      const raw = (m.body || '').trim()
      if (/^\s*\[[A-Z_]+\]/.test(raw) || /HUMAN_HANDOVER/.test(raw) || /^\s*🛎/u.test(raw)) continue
      // Media descriptor captured at webhook time (metadata.media). Newer rows
      // carry the Meta media id; the client renders via a same-origin proxy
      // keyed on the wa_messages row id. Legacy media rows have no id => url null
      // so the client falls back to a chip instead of the old "[media message]".
      const md = m.metadata?.media
      const media: MediaInfo[] | undefined = md
        ? [{
            kind: md.kind,
            url: md.id ? `/api/admin/inbox/media/${m.id}` : null,
            mimeType: md.mime_type,
            filename: md.filename,
          }]
        : undefined
      // Body: a media caption (already stored as body) or the template label.
      // For a bare media row with no caption, leave the text empty so the bubble
      // shows only the image/chip (no literal "[media message]" string).
      const body = raw.replace(/^\s*\[[a-z0-9_]+\]\s*/, '') || (m.template_name ? `[template: ${m.template_name}]` : '')
      // A row with no text AND no media descriptor is a reaction / system event /
      // unsupported type we don't capture. SKIP it — never show the misleading
      // "[media message]" label (Taona 2026-06-29). Real media has `media` set and
      // renders via the client MediaBubble; legacy media (descriptor present, id
      // null) keeps its honest chip because `media` is still defined.
      if (!body && !media) continue
      // Outbound attribution: an agent (metadata.sent_by) replied, else it was
      // the auto-bot (no sender stamp and no human took over historically).
      const sentBy = local(m.metadata?.sent_by)
      const out = m.direction !== 'in'
      comms.push({
        id: `wa:${m.id}`,
        channel: 'whatsapp',
        direction: out ? 'out' : 'in',
        body,
        at: m.created_at,
        from: !out ? `+${m.wa_phone.replace(/^\+/, '')}` : sentBy || 'Bot',
        bot: out && !sentBy,
        ...(media ? { media } : {}),
      })
    }
  }

  // ---- Email by peer_email ----
  if (email) {
    const { data: threads } = await db
      .from('support_inbox_threads')
      .select('id, peer_email, subject')
      .ilike('peer_email', email)
    if (threads?.length) {
      const ids = threads.map((t) => t.id)
      const { data: msgs } = await db
        .from('support_inbox_messages')
        .select('id, thread_id, direction, from_address, subject, body_text, received_at, sent_by')
        .in('thread_id', ids)
        .order('received_at', { ascending: true })
        .limit(500)
      const subjById = new Map(threads.map((t) => [t.id, t.subject]))
      for (const m of (msgs || []) as Array<{ id: string; thread_id: string; direction: string; from_address: string; subject: string | null; body_text: string | null; received_at: string; sent_by: string | null }>) {
        const { cleanBody, attachments } = parseAttachmentMarker(m.body_text)
        const body = cleanBody || m.subject || ''
        if (!body && !attachments.length) continue
        const out = m.direction !== 'in'
        const media: MediaInfo[] | undefined = attachments.length
          ? attachments.map((a, i) => ({
              kind: kindForMime(a.mimeType),
              url: `/api/admin/inbox/media/mail:${m.id}:${i}`,
              mimeType: a.mimeType,
              filename: a.filename,
            }))
          : undefined
        comms.push({
          id: `mail:${m.id}`,
          channel: 'email',
          direction: out ? 'out' : 'in',
          body,
          at: m.received_at,
          from: !out ? m.from_address : (local(m.sent_by ? adminEmailById.get(m.sent_by) : null) || 'Team'),
          subject: m.subject || subjById.get(m.thread_id) || undefined,
          ...(media ? { media } : {}),
        })
      }
    }
  }

  comms.sort((a, b) => +new Date(a.at) - +new Date(b.at))
  return NextResponse.json({ messages: stripEftMessages(comms, (m) => m.body, hide) })
}
