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
import { vendorCommsInEftLane, isEftAdmin, getEftMode, mentionsEft, isOperatorPreviewAddress } from '@/lib/eft'
import { BOT_ADMINS } from '@/lib/bot/admins'

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
  last_channel: 'whatsapp' | 'email'  // channel of the most recent message (for a badge)
}

const norm = (p: string) => p.replace(/^\+/, '')
// Canonical key for matching a WhatsApp thread's E.164 number to a vendor row.
// vendor_applications.phone is stored in mixed formats (local "0760712578" vs
// E.164 "+27760712578"), so stripping only "+" fails to match (0-prefix vs
// 27-prefix). Match on the last 9 digits (the ZA subscriber number), the same
// canonical used by isInternalAccount and the webhook. Without this, an unpaid/
// collected vendor's thread fails to resolve to their application, is never
// EFT-classified, and LEAKS onto the festival owner's main inbox (Taona 2026-07-25).
const phoneKey = (p: string) => (p || '').replace(/\D/g, '').slice(-9)

// Marketing / automated / newsletter senders that should NEVER count as "a human
// is waiting" (they filled the Needs You queue with Smart Points travel deals,
// Substack newsletters, etc.). Two axes: an automated local-part (noreply, deals,
// newsletter…) OR a known bulk/ESP domain. Real cold enquiries from a person
// (admin@somecompany.co.za) are NOT matched, so genuine new clients still show.
// They remain visible in the main Inbox; this only drops them from Needs You.
const AUTOMATED_LOCAL = /(^|[._-])(no?[._-]?reply|do[._-]?not[._-]?reply|donotreply|mailer[._-]?daemon|mailer|bounce|postmaster|newsletter|marketing|promo|promotions?|notifications?|notify|alerts?|updates?|deals?|offers?|campaigns?|automated)([._-]|$)/
const BULK_DOMAIN = /(substack\.com|mailchimp|mcsv\.net|mcdlv\.net|sendgrid|sparkpostmail|mailgun|amazonses|sendinblue|brevo|brevosend|metamail\.com|hubspot|marketo|klaviyomail|list-manage|constantcontact|dollarflightclub\.com|thedailynavigator|sage\.com|smartcall\.co\.za|beehiiv|convertkit|drip\.com|activehosted|customer\.io|intercom-mail|mailerlite|getresponse|aweber)/
// Our OWN addresses landing as a "peer" = a system self-notification (e.g. the
// notifyOwners email backstop "[YAH] vendor support message"), never a client.
const INTERNAL_DOMAIN = /(^|\.)(youngatheart\.co\.za|cthalaal\.co\.za)$/
function isAutomatedEmail(email: string): boolean {
  const at = email.toLowerCase().indexOf('@')
  if (at < 0) return false
  const local = email.slice(0, at).toLowerCase()
  const domain = email.slice(at + 1).toLowerCase()
  return AUTOMATED_LOCAL.test(local) || BULK_DOMAIN.test(domain) || INTERNAL_DOMAIN.test(domain)
}
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
  // TEMPORARY EFT lane: only vendors ACTIVELY handled for EFT (individually added,
  // or who uploaded a proof) are pulled OUT of the main inbox onto the dev /admin/eft
  // tab. INDEPENDENT of global mode: turning global on shows all unpaid vendors the
  // EFT bank details but does NOT move their conversations off the main inbox.
  const eftOnly = url.searchParams.get('eftOnly') === '1'
  // The EFT tab feed (eftOnly=1) is DEV-ONLY. A non-EFT admin (e.g. Samreen) must
  // never retrieve the EFT cohort's conversations, even by crafting this request
  // directly. The main inbox (no eftOnly) already excludes them from every other
  // admin's list; this seals the direct-API path too.
  if (eftOnly && !isEftAdmin(user.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // ---- Resolution maps: phone -> vendor, email -> vendor ----
  const { data: apps } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, phone, email, admin_notes, paid_at')
    .limit(2000)
  const byPhone = new Map<string, { id: string; business_name: string | null; contact_name: string | null; email: string | null }>()
  const byEmail = new Map<string, { id: string; business_name: string | null; contact_name: string | null; phone: string | null }>()
  const byId = new Map<string, { id: string; business_name: string | null; contact_name: string | null; phone: string | null }>()
  const eftAppIds = new Set<string>()
  // Which vendors leave the festival owner's inbox, via the SAME predicate the
  // owner-alert gate uses (vendorCommsInEftLane in lib/bot/notify.ts) so the two
  // surfaces can never disagree about who is on the lane.
  //
  // NOTE, corrected 2026-07-25: an earlier comment here claimed global mode "does
  // NOT sweep ordinary unpaid vendors". That was never what the code did —
  // vendorCommsInEftLane returns `hasEftMarker || eft_submitted_at || globalOn`,
  // so while global mode is ON every unpaid, non-excluded vendor IS on the lane
  // (69 of 121 approved vendors at the time of writing). ⟦NOEFT⟧, internal
  // accounts and any vendor with paid_at set are the exclusions. Do not "fix" the
  // code to match the old comment; the sweep is intended and self-reverts when
  // global mode goes off.
  const globalOn = await getEftMode()
  for (const a of (apps || []) as Array<{ id: string; business_name: string | null; contact_name: string | null; phone: string | null; email: string | null; admin_notes: string | null; paid_at: string | null }>) {
    if (phoneKey(a.phone || '')) byPhone.set(phoneKey(a.phone || ''), { id: a.id, business_name: a.business_name, contact_name: a.contact_name, email: a.email })
    if (a.email) byEmail.set(a.email.toLowerCase(), { id: a.id, business_name: a.business_name, contact_name: a.contact_name, phone: a.phone })
    byId.set(a.id, { id: a.id, business_name: a.business_name, contact_name: a.contact_name, phone: a.phone })
    if (vendorCommsInEftLane(a.admin_notes, a.paid_at, globalOn, { email: a.email, phone: a.phone })) eftAppIds.add(a.id)
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
  // "Needs You" queue derivation (no DDL, Law 8) — all from wa_messages:
  //   needsHumanAt: latest [NEEDS_HUMAN] escalation marker per phone (the bot
  //     told the vendor "I've passed this to the team"; a human owes a follow-up).
  //   humanReplyAt: latest OUTBOUND reply that carries metadata.sent_by (a real
  //     human replied through the composer, not the bot). An escalation is
  //     considered handled once a human reply lands AFTER it. Scan is created_at
  //     DESC, so the first marker/reply seen per phone is the latest.
  const needsHumanAt = new Map<string, string>()
  const humanReplyAt = new Map<string, string>()

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
        last_channel: channel,
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
        existing.last_channel = channel
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
    // Paginated scan instead of one .limit(N) call (Taona 2026-07-12): a fixed
    // cap on raw messages (across ALL vendors combined) silently drops a
    // conversation from the list the moment its last message falls outside
    // the window — no error, it just vanishes. Worse, one busy thread (the
    // vendor agent's tool-call/receipt/reply chatter) can crowd out a
    // quieter vendor's single unread message. DDL is blocked on this
    // Supabase project (CTH-DOCTRINE law 8), so a DISTINCT ON query or a
    // supporting index isn't available — instead we page through in DESC
    // order and stop once two consecutive pages add NO new phones (every
    // active conversation is very likely already covered), capped at
    // MAX_PAGES as a hard safety ceiling either way. wa_messages is at 1,408
    // rows as of 2026-07-12 (one page), so this costs nothing today and
    // scales as real volume grows instead of silently dropping vendors.
    const PAGE_SIZE = 1000
    const MAX_PAGES = 10
    const seenPhone = new Set<string>()
    // Bot handover state: the FIRST [HUMAN_HANDOVER_ON/OFF] marker we see per
    // phone is the latest (rows are created_at DESC). ON => bot paused, a human
    // is handling; OFF => bot auto-replying.
    const handoverSeen = new Set<string>()
    let consecutiveEmptyPages = 0
    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      const from = pageIdx * PAGE_SIZE
      const { data: wa } = await db
        .from('wa_messages')
        .select('wa_phone, direction, body, created_at, metadata')
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1)
      if (!wa || wa.length === 0) break // exhausted the whole table

      const phonesBeforePage = seenPhone.size
      for (const m of wa as Array<{ wa_phone: string; direction: string; body: string | null; created_at: string; metadata: { media?: { kind?: string } } | null }>) {
        const phone = norm(m.wa_phone || '')
        if (!phone) continue
        const raw = (m.body || '').trim()
        if (!handoverSeen.has(phone)) {
          if (/^\[HUMAN_HANDOVER_ON\]/.test(raw)) { handoverPaused.set(phone, true); handoverSeen.add(phone) }
          else if (/^\[HUMAN_HANDOVER_OFF\]/.test(raw)) { handoverPaused.set(phone, false); handoverSeen.add(phone) }
        }
        // Needs-You signals (recorded before the isMarker skip so the marker row
        // itself never pollutes the preview but still flags the queue). First
        // seen per phone = latest, since the scan runs created_at DESC.
        if (/^\[NEEDS_HUMAN\]/.test(raw) && !needsHumanAt.has(phone)) needsHumanAt.set(phone, m.created_at)
        if (m.direction === 'out' && (m.metadata as { sent_by?: string } | null)?.sent_by && !humanReplyAt.has(phone)) {
          humanReplyAt.set(phone, m.created_at)
        }
        if (isMarker(raw)) continue
        // Strip a leading lowercase template tag (e.g. "[vendor_payment_confirmation] …")
        // so the preview reads as the actual message, not the tag. When the message
        // is media with no caption, show a media label ("📷 Photo") instead of the
        // bare "[no text]" fallback so the operator can see what the vendor sent.
        const stripped = raw.replace(/^\s*\[[a-z0-9_]+\]\s*/, '')
        const mediaLabel = mediaPreviewLabel(m.metadata?.media?.kind)
        const body = (stripped || mediaLabel || '[no text]')
        const vendor = byPhone.get(phoneKey(m.wa_phone || ''))
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

      const newPhonesThisPage = seenPhone.size - phonesBeforePage
      consecutiveEmptyPages = newPhonesThisPage === 0 ? consecutiveEmptyPages + 1 : 0
      if (consecutiveEmptyPages >= 2) break // converged: two pages running found no new conversation
      if (wa.length < PAGE_SIZE) break // last page was partial — table exhausted

      if (pageIdx === MAX_PAGES - 1) {
        console.warn(`[inbox/unified] WhatsApp scan hit MAX_PAGES (${MAX_PAGES}) without converging — some older conversations may be missing from the list. Time to build the real per-phone-latest query.`)
      }
    }
  }

  // Which mailbox each email peer reached us on — 'gmail' = Samreen's
  // capetownhalaal@gmail.com, else the support@youngatheart.co.za primary. Read
  // from the latest INBOUND support message per peer (same signal the reply
  // route uses to pick the from-address). Lets the UI badge the two email
  // channels apart, so all THREE client channels (WhatsApp / YAH email / Gmail)
  // are visible in the queue. One query; latest wins because we scan DESC.
  const mailboxByPeer = new Map<string, 'gmail' | 'youngatheart'>()
  {
    const { data: msgs } = await db
      .from('support_inbox_messages')
      .select('from_address, mailbox, received_at')
      .eq('direction', 'in')
      .order('received_at', { ascending: false })
      .limit(4000)
    for (const m of (msgs || []) as Array<{ from_address: string | null; mailbox: string | null; received_at: string }>) {
      const from = (m.from_address || '').toLowerCase().trim()
      if (!from || mailboxByPeer.has(from)) continue
      mailboxByPeer.set(from, m.mailbox === 'gmail' ? 'gmail' : 'youngatheart')
    }
  }

  // ---- Email/Support: support_inbox_threads by peer_email ----
  // ALWAYS runs too — same reasoning as the WhatsApp block above.
  {
    const { data: threads } = await db
      .from('support_inbox_threads')
      .select('peer_email, peer_name, subject, status, tag, assignee_id, last_handled_at, last_inbound_at, unread_count, created_at, vendor_application_id')
      .order('last_handled_at', { ascending: false, nullsFirst: false })
      .limit(1500)
    for (const t of (threads || []) as Array<{ peer_email: string; peer_name: string | null; subject: string | null; status: string | null; tag: string | null; assignee_id: string | null; last_handled_at: string | null; last_inbound_at: string | null; unread_count: number | null; created_at: string; vendor_application_id: string | null }>) {
      const email = (t.peer_email || '').toLowerCase()
      if (!email) continue
      // Resolve the vendor by the sender's registered email OR, when that misses
      // (the vendor wrote from a secondary address), by the thread's linked
      // vendor_application_id. This lets a vendor emailing from an unknown address
      // still be recognised and, in global EFT mode, swept off this inbox.
      const vendor = byEmail.get(email) || (t.vendor_application_id ? byId.get(t.vendor_application_id) : null)
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
    const unread =
      c.last_direction === 'in' &&
      (!readAt || !c.last_message_at || new Date(c.last_message_at) > new Date(readAt))
    const p = c.phone ? norm(c.phone) : ''
    const botPaused = c.phone ? (handoverPaused.get(p) ?? false) : false
    // Open escalation: the bot flagged a human follow-up and no human has
    // replied since. This catches the "I've passed this to the team" case where
    // the bot already replied, so `unread` is false yet a human still owes work.
    const escAt = p ? needsHumanAt.get(p) : undefined
    const repliedAt = p ? humanReplyAt.get(p) : undefined
    const openEscalation = !!escAt && (!repliedAt || new Date(escAt) > new Date(repliedAt))
    // "Needs a RESPONSE" (not just needs a human): the customer sent the last
    // message and no reply has gone back, OR the bot escalated a follow-up a
    // human still owes. Keyed on last_direction === 'in', NOT read state — so
    // merely OPENING a conversation does not clear it; only actually replying
    // (which flips last_direction to 'out') or resolving does. That is the
    // difference: a read-but-unanswered thread still needs a response. (`unread`
    // and `bot_paused` are still returned for the main inbox's own badges.)
    // Drop marketing/automated email-only senders (they still show in the full
    // Inbox). Vendors and anything on WhatsApp are always kept.
    const automatedNoise = !c.phone && !c.application_id && !!c.email && isAutomatedEmail(c.email)
    const needs_response = c.status !== 'resolved' && (c.last_direction === 'in' || openEscalation) && !automatedNoise
    // Mailbox tag for email contacts so the UI can tell the two email channels
    // apart (Gmail vs support@youngatheart). Null for WhatsApp-only contacts.
    const mailbox = c.email ? (mailboxByPeer.get(c.email.toLowerCase()) || 'youngatheart') : null
    return { ...c, read_at: readAt, unread, bot_paused: botPaused, needs_response, mailbox }
  })
  list.sort((a, b) => +new Date(b.last_message_at || 0) - +new Date(a.last_message_at || 0))

  // TEMPORARY EFT lane partition. A contact is EFT iff it resolves to a vendor in
  // the lane; non-vendor ticket buyers are never EFT and always stay on the main
  // inbox. eftOnly=1 keeps ONLY EFT contacts (the /admin/eft feed); the main inbox
  // drops them. Counts derive from the SAME partition so the tab badges stay true.
  // Drop the MASTER line (Taona) from every inbox: its bot thread carries the
  // master-brain's cross-vendor replies (names, phones, amounts), so leaving it
  // visible would let another operator open it and read cross-vendor PII out of
  // the transcript (the residue leak past the tool wall). We exclude ONLY the
  // master, NOT the festival owner: a real vendor (GLOBAL CUISINE) shares the
  // owner's exact number, so blanket-excluding operator lines would wrongly hide
  // that vendor's thread. The owner seeing her own thread is not a leak; the
  // master's cross-vendor thread reaching her is, and this seals exactly that.
  const masterPhoneDigits = new Set(BOT_ADMINS.filter((a) => a.role === 'master').map((a) => norm(a.phone)))
  const isMasterThread = (c: { phone: string | null }) => !!c.phone && masterPhoneDigits.has(norm(c.phone))
  const visible = list.filter((c) => !isMasterThread(c))
  // A contact is EFT (confined to the dev-only EFT feed, dropped from every other
  // inbox) when it resolves to an EFT-lane vendor, OR it is the EFT admin's own
  // address (dev@) whose thread carries the master-brain alert backstop with
  // cross-vendor PII. Those alerts must live only on the EFT tab, never the general
  // inbox where the festival owner could open them (Taona 2026-07-24).
  const isEftContact = (c: { application_id: string | null; email: string | null }) =>
    (!!c.application_id && eftAppIds.has(c.application_id)) || isEftAdmin(c.email) ||
    isOperatorPreviewAddress(c.email) // operator preview threads (e.g. taonac96@) stay off the owner's inbox
  // EFT-content guard: a non-EFT admin (Samreen) never sees a thread whose latest
  // message mentions EFT, even if the contact carries no lane marker (Taona
  // 2026-07-24: "any email or whatsapp that mentions eft must be auto excluded
  // from samreen"). The durable per-vendor seal remains the ⟦EFT⟧ marker
  // (eftAppIds, above); this is the display-layer net for the visible message.
  const viewerIsEftAdmin = isEftAdmin(user.email)
  const eftMention = (c: { last_preview: string | null }) => !viewerIsEftAdmin && mentionsEft(c.last_preview)
  const scoped = eftOnly
    ? visible.filter(isEftContact)
    : visible.filter((c) => !isEftContact(c) && !eftMention(c))

  const counts = {
    all: scoped.length,
    whatsapp: scoped.filter((c) => c.channels.includes('whatsapp')).length,
    email: scoped.filter((c) => c.channels.includes('email')).length,
    unread: scoped.filter((c) => c.unread).length,
    needs_response: scoped.filter((c) => c.needs_response).length,
  }

  const displayList = channelFilter === 'all' ? scoped : scoped.filter((c) => c.channels.includes(channelFilter))

  return NextResponse.json({ contacts: displayList.slice(0, 500), counts })
}
