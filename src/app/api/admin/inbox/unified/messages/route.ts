// Unified thread view — all messages for a CONTACT across WhatsApp + email.
// Takes the contact's phone and/or email directly (the unified list provides
// both), so it works for ticketed AND ticketless conversations. No wa_threads.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseAttachmentMarker } from '@/lib/email/attachments'
import { stripRfc822Headers } from '@/lib/inbox/email-body'
import { sanitizeEmailHtml } from '@/lib/sanitize'
import { hidesEftContent, stripEftMessages, laneScopeFor } from '@/lib/inbox-lane'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// CommItem + MediaInfo are the shared wire type in @/lib/inbox/types — this
// route is their producer and both inbox clients are the consumers, so the
// shape is defined once rather than three times.
import type { CommItem, MediaInfo } from '@/lib/inbox/types'

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
      .select('id, direction, body, created_at, wa_phone, template_name, metadata, status, error')
      .or(`wa_phone.eq.+${noPlus},wa_phone.eq.${noPlus}`)
      // DESC + limit, reversed below: ascending + limit returns the OLDEST 400,
      // so past 400 messages a thread froze on ancient history and new messages
      // never appeared at all. We want the newest 400.
      .order('created_at', { ascending: false })
      .limit(400)
    for (const m of (msgs || []) as Array<{ id: string; direction: string; body: string | null; created_at: string; wa_phone: string; template_name: string | null; metadata: { sent_by?: string; via?: string; media?: { kind: 'image' | 'document' | 'video' | 'audio' | 'sticker'; id?: string; mime_type?: string; filename?: string; caption?: string } } | null; status: string | null; error: string | null }>) {
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
        // Delivery state, outbound only — the ticks. wa_messages.status has been
        // written by the webhook all along and simply was never selected, so the
        // inbox could not tell a delivered message from a failed one.
        ...(out && m.status ? { status: m.status as CommItem['status'] } : {}),
        ...(out && m.error ? { error: m.error } : {}),
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
        .select('id, thread_id, direction, from_address, from_name, to_address, subject, body_text, body_html, mailbox, received_at, created_at, sent_by')
        .in('thread_id', ids)
        // DESC + limit for the same reason as the WhatsApp select, and ordered by
        // created_at (row insert) rather than received_at (the SENDER's Date
        // header, which is client-controlled and frequently skewed).
        .order('created_at', { ascending: false })
        .limit(500)
      const subjById = new Map(threads.map((t) => [t.id, t.subject]))
      for (const m of (msgs || []) as Array<{ id: string; thread_id: string; direction: string; from_address: string; from_name: string | null; to_address: string | null; subject: string | null; body_text: string | null; body_html: string | null; mailbox: string | null; received_at: string; created_at: string | null; sent_by: string | null }>) {
        const { cleanBody, attachments } = parseAttachmentMarker(m.body_text)
        // stripRfc822Headers server-side: both mail fetchers fall back to slicing
        // raw MIME when mailparser returns no text, so some rows carry
        // `Return-Path:` / `Received:` blocks (or a base64 blob) in body_text.
        // The OLD support inbox defended against this locally while the unified
        // inbox rendered it verbatim. Fixing it here fixes it for every consumer.
        const body = stripRfc822Headers(cleanBody) || m.subject || ''
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
          // ARRIVAL time, not the sender's Date header. Both channels are now on
          // the same clock, so the final sort below is meaningful. Previously
          // WhatsApp carried created_at (insert) while email carried received_at
          // (the sender's own, client-controlled, frequently skewed timestamp) —
          // so a cron-fetched email materialised BACKWARDS into history minutes
          // after a WhatsApp that logically followed it, and the open thread
          // visibly reordered itself under the operator's cursor.
          at: m.created_at || m.received_at,
          // Display name, falling back to the local part — the unified inbox
          // used to show the bare address where from_name was available all along.
          from: !out
            ? (m.from_name?.trim() || local(m.from_address) || m.from_address)
            : (local(m.sent_by ? adminEmailById.get(m.sent_by) : null) || 'Team'),
          subject: m.subject || subjById.get(m.thread_id) || undefined,
          // SANITISED HERE, on the server. The renderer trusts this by contract
          // and must not re-sanitise; any other producer of bodyHtml would skip
          // the allowlist entirely.
          ...(m.body_html ? { bodyHtml: sanitizeEmailHtml(m.body_html) } : {}),
          ...(!out ? { fromAddress: m.from_address } : {}),
          ...(m.to_address ? { to: m.to_address } : {}),
          mailbox: m.mailbox === 'gmail' ? 'gmail' : 'youngatheart',
          // The sender's own declared time — what a mail client shows as "sent".
          // `at` above is arrival, which is what we sort on.
          ...(m.received_at ? { sentAt: m.received_at } : {}),
          ...(media ? { media } : {}),
        })
      }
    }
  }

  comms.sort((a, b) => +new Date(a.at) - +new Date(b.at))
  // EFT wall: the accessor MUST cover every field that can carry message text.
  // It used to read `m.body` alone, which was complete until bodyHtml existed —
  // an email whose plain-text part is empty but whose HTML says "I sent the EFT"
  // would otherwise sail straight past the content filter shipped in eda870d.
  return NextResponse.json({
    messages: stripEftMessages(comms, (m) => [m.body, m.subject, m.bodyHtml].filter(Boolean).join(' '), hide),
  })
}
