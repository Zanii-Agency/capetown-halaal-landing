/**
 * Per-channel thread loaders. One loader per channel, each touching ONLY its own
 * tables.
 *
 * WHY SEPARATE LOADERS AND NOT A FILTER (Taona, 2026-07-27): "they should not
 * communicate and be aware, filtering the same inbox has proven inefficient and
 * it keeps breaking." He is right about the cause. The unified list built ONE
 * contact map out of WhatsApp and email, merged a vendor's two channels into a
 * single row, and only filtered by channel at the very end. Every fix therefore
 * had to hold for three shapes at once, and a change made for email regularly
 * broke WhatsApp. Here the WhatsApp loader never reads a mail table and the mail
 * loader never reads wa_messages: there is no shared state left to break.
 *
 * WHERE THE CHANNELS MEET: on the VENDOR, not in a list. /api/admin/comms/timeline
 * already aggregates one contact's WhatsApp + email + notes and is already
 * lane-sealed. One person's full history is context; a blended list of unrelated
 * people is noise.
 *
 * THE SEAL IS INSIDE THIS FILE, ON PURPOSE. Every loader applies laneScopeFor
 * itself and cannot return a row the viewer must not see. A caller cannot forget
 * it, because there is no unsealed function to call. This is the lesson from
 * sealing eleven endpoints one at a time: a filtered list in front of an
 * unfiltered reader is cosmetic. Samreen's blindness to the master lane survives
 * this rewrite or the rewrite does not ship.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { laneScopeFor } from '@/lib/inbox-lane'
import { withoutMerged } from '@/lib/merge'
import { BOT_ADMINS } from '@/lib/bot/admins'
import { canPin } from '@/lib/inbox/automated'
import { loadDoneMarks, isCleared } from '@/lib/inbox/queue-state'

export type MailBox = 'support' | 'gmail'
export type ChannelKey = 'whatsapp' | MailBox

export interface ChannelThread {
  /** Stable per-channel key. Deliberately NOT shared across channels. */
  id: string
  channel: ChannelKey
  peer_name: string | null
  business_name: string | null
  phone: string | null
  email: string | null
  application_id: string | null
  subject: string | null
  last_message_at: string | null
  last_preview: string | null
  last_direction: 'in' | 'out' | null
  unread: boolean
  /**
   * A human owes this person a reply. Replaces the separate "Needs You" queue
   * (Taona, 2026-07-27: "this must be gone, and by default when a human is
   * needed that chat must be pinned to the top of the chats until resolved").
   * A queue you have to remember to visit is a queue that goes stale; a pin in
   * the list you already live in cannot be missed.
   */
  needs_response: boolean
  /** Bot is silenced on this thread (a [HUMAN_HANDOVER_ON] marker is the latest).
   *  Without this the operator cannot see whether the bot is still answering. */
  bot_paused: boolean
}

const phoneKey = (p: string | null | undefined) => (p || '').replace(/\D/g, '').slice(-9)

/** Our own bookkeeping rows, never conversation. Same predicate as
 *  unified/route.ts:81 and the skip in messages/route.ts:76, so the list and the
 *  open thread finally agree on what counts as a message. */
export const isMarker = (b: string) =>
  /^\s*\[[A-Z_]+\]/.test(b) || /HUMAN_HANDOVER/.test(b) || /^\s*🛎/u.test(b)

/** Preview label for a media-only message, so the list reads "📷 Photo" rather
 *  than an empty row. Mirrors the kinds the webhook stores on metadata.media. */
function mediaPreviewLabel(kind: string | undefined): string | null {
  switch (kind) {
    case 'image': return '📷 Photo'
    case 'document': return '📎 Document'
    case 'audio': return '🎙 Voice note'
    case 'video': return '🎬 Video'
    default: return null
  }
}

/** First readable line of an email, whichever part carries it. */
function mailPreview(text: string | null | undefined, html: string | null | undefined): string {
  const t = (text || '').trim()
  if (t) return t.replace(/\s+/g, ' ')
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}
const norm = (p: string) => p.replace(/^\+/, '')

/** EVERY operator line, not just the master one. Operator threads are never
 *  customer conversations.
 *
 *  This filtered on role==='master' only, so Samreen (role 'festival_owner')
 *  was not excluded — and because she also holds a vendor application on her own
 *  number, her private operator alert feed rendered in the inbox as a vendor
 *  conversation titled "GLOBAL CUISINE", full of SYSTEM ALERTs about OTHER
 *  vendors. Nothing leaked to a vendor (the messages were correctly addressed to
 *  her), but an operator reading that screen would reasonably conclude it had. */
const OPERATOR_PHONES = new Set(BOT_ADMINS.map((a) => phoneKey(a.phone)))

interface VendorLite {
  id: string
  business_name: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  admin_notes: string | null
}

/** One vendor read, shared by both loaders for display names only. */
async function vendorIndex(db: ReturnType<typeof createAdminClient>) {
  const { data } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, phone, email, admin_notes')
  const all = (data || []) as VendorLite[]

  // Merged duplicates point at their primary. A thread can still carry the
  // SUBORDINATE's id (support_inbox_threads.vendor_application_id was stamped
  // before the merge), and the subordinate carries none of the payment state, so
  // a lane decision made on it is made on a row that no longer describes the
  // vendor. The seal-verification script caught exactly this: DoubleTakeBooth and
  // A&H Homeware read as master-lane and would have been hidden from Samreen,
  // when both are PAID and hers. It fails the other way too, which is worse: a
  // subordinate with no EFT marker would EXPOSE a vendor the primary hides.
  // Normalise every id to its primary before anything reads payment state.
  const primaryOf = new Map<string, string>()
  for (const v of all) {
    const m = /⟦MERGED:([0-9a-fA-F-]{36})⟧/.exec(v.admin_notes || '')
    if (m) primaryOf.set(v.id, m[1])
  }
  const toPrimary = (id: string | null | undefined): string | null =>
    id ? (primaryOf.get(id) ?? id) : null

  const rows = withoutMerged(all) as VendorLite[]
  const byId = new Map(rows.map((v) => [v.id, v]))
  const byPhone = new Map<string, VendorLite>()
  const byEmail = new Map<string, VendorLite>()
  for (const v of rows) {
    const k = phoneKey(v.phone)
    if (k.length === 9 && !byPhone.has(k)) byPhone.set(k, v)
    if (v.email) byEmail.set(v.email.toLowerCase(), v)
  }
  return { byPhone, byEmail, byId, toPrimary }
}

/**
 * WhatsApp threads, aggregated from wa_messages by phone. Reads no mail table.
 *
 * needs_response mirrors the derivation the retired Needs You queue used: the
 * latest [NEEDS_HUMAN] escalation marker counts as outstanding until a HUMAN
 * reply (an outbound carrying sent_by, i.e. sent through the composer rather
 * than by the bot) lands after it. A bot reply does not clear it, which is the
 * whole point: the bot replying is often why a human is needed.
 */
export async function loadWhatsAppThreads(viewerEmail: string | null | undefined): Promise<ChannelThread[]> {
  const db = createAdminClient()
  const scope = await laneScopeFor(viewerEmail)
  const { byPhone, toPrimary } = await vendorIndex(db)
  const doneMarks = await loadDoneMarks()

  const threads = new Map<string, ChannelThread>()
  const needsHumanAt = new Map<string, string>()
  const humanReplyAt = new Map<string, string>()
  const lastInboundAt = new Map<string, string>()
  const lastOutboundAt = new Map<string, string>()
  const botPaused = new Map<string, boolean>()
  const handoverSeen = new Set<string>()

  // PAGE, do not cap. `.limit(4000)` silently returned 1000 rows, because
  // PostgREST enforces db-max-rows=1000 on this project, so this list only ever
  // saw the newest ELEVEN DAYS and 88 of 204 threads (43%) were missing from it
  // with no error and no "load more" — they simply aged out and never returned.
  // unified/route.ts:259-334 already pages exactly like this and carries a
  // comment warning that a fixed cap "silently drops a conversation from the
  // list the moment its last message falls outside the window". This loader
  // reintroduced the bug that comment was written about.
  //
  // Stop once two consecutive pages surface no new phone (every live
  // conversation is covered by then), with MAX_PAGES as a hard ceiling.
  const PAGE_SIZE = 1000
  const MAX_PAGES = 10
  let emptyPages = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE
    const { data: msgs } = await db
      .from('wa_messages')
      // NO read_at: that column does not exist on wa_messages, and selecting it
      // made the whole query error, so this loader once returned ZERO threads.
      .select('id, wa_phone, direction, body, created_at, metadata')
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (!msgs || msgs.length === 0) break

    const before = threads.size

    // NO stripEftMessages. Taona 2026-07-27: the festival owner sees her own
    // vendors in full. The content strip removed any message mentioning "EFT" or
    // "proof of payment" from threads she was ALREADY allowed to open, which
    // mostly meant hiding the vendor's own questions ("I have already emailed my
    // proof of payment") and the bot's harmless "we are card only" answers, so
    // her conversations read with holes: an answer on screen with no question.
    // Verified before removing it: the real account number, branch code and
    // account name appear in 0 of 2,617 WhatsApp messages, because the bot never
    // had them. The VENDOR-level seal below is untouched and still hides every
    // master-lane vendor from her completely.
    for (const m of msgs as Array<{
      id: string; wa_phone: string; direction: 'in' | 'out'; body: string | null
      created_at: string; metadata: Record<string, unknown> | null
    }>) {
      const k = phoneKey(m.wa_phone)
      if (k.length !== 9 || OPERATOR_PHONES.has(k)) continue
      const vendor = byPhone.get(k)
      if (scope.blocks({ phone: m.wa_phone, applicationId: toPrimary(vendor?.id) })) continue

      const raw = (m.body || '').trim()

      // Signals are read BEFORE the marker skip, so a marker still flags the
      // queue without ever becoming the visible preview. Rows are created_at
      // DESC, so the first hit per phone is the latest.
      if (!handoverSeen.has(k)) {
        if (/^\[HUMAN_HANDOVER_ON\]/.test(raw)) { botPaused.set(k, true); handoverSeen.add(k) }
        else if (/^\[HUMAN_HANDOVER_OFF\]/.test(raw)) { botPaused.set(k, false); handoverSeen.add(k) }
      }
      if (/\[NEEDS_HUMAN\]/.test(raw) && !needsHumanAt.has(k)) needsHumanAt.set(k, m.created_at)
      if (m.direction === 'out' && m.metadata?.sent_by && !humanReplyAt.has(k)) humanReplyAt.set(k, m.created_at)

      // Markers are OUR bookkeeping, not conversation. 115 of them were winning
      // last_preview in the list while messages/route.ts categorically refuses
      // to render them in the thread, so the list and the open thread showed
      // different things for the same conversation.
      if (isMarker(raw)) continue

      if (m.direction === 'in' && !lastInboundAt.has(k)) lastInboundAt.set(k, m.created_at)
      if (m.direction === 'out' && !lastOutboundAt.has(k)) lastOutboundAt.set(k, m.created_at)

      if (!threads.has(k)) {
        const stripped = raw.replace(/^\s*\[[a-z0-9_]+\]\s*/, '')
        const media = (m.metadata as { media?: { kind?: string } } | null)?.media?.kind
        threads.set(k, {
          id: `wa:${norm(m.wa_phone)}`,
          channel: 'whatsapp',
          peer_name: vendor?.contact_name ?? null,
          business_name: vendor?.business_name ?? null,
          phone: m.wa_phone,
          email: vendor?.email ?? null,
          application_id: vendor?.id ?? null,
          subject: null,
          last_message_at: m.created_at,
          last_preview: (stripped || mediaPreviewLabel(media) || '[no text]').slice(0, 120),
          last_direction: m.direction,
          unread: false,
          needs_response: false,
          bot_paused: false,
        })
      }
    }

    if (msgs.length < PAGE_SIZE) break
    emptyPages = threads.size === before ? emptyPages + 1 : 0
    if (emptyPages >= 2) break
  }

  for (const [k, t] of threads) {
    const inAt = lastInboundAt.get(k)
    const anyOut = lastOutboundAt.get(k)
    const humanOut = humanReplyAt.get(k)
    t.unread = !!inAt && (!anyOut || new Date(anyOut) < new Date(inAt))

    // THE PIN, rewritten. It used to mean "no HUMAN has replied since they
    // wrote", and since only 28 of 1,879 outbound messages carry a human sender,
    // that was true of 82 of 84 threads. A pin on 98% of a list is not a queue.
    //
    // Now: nobody at all has answered them (the bot counts as an answer), OR the
    // bot explicitly escalated and no human has picked that up yet, AND the
    // operator has not marked it done. The manual clear is the part that
    // matters: derived state alone can never be emptied by the person working it.
    const escalated = needsHumanAt.get(k)
    const escalationOpen = !!escalated && (!humanOut || new Date(humanOut) < new Date(escalated))
    const nobodyAnswered = !!inAt && (!anyOut || new Date(anyOut) < new Date(inAt))
    t.needs_response =
      (nobodyAnswered || escalationOpen) && !isCleared(doneMarks.get(t.id), inAt ?? null)
    t.bot_paused = botPaused.get(k) === true
  }

  return sortPinned([...threads.values()])
}

/**
 * Mail threads for ONE mailbox. Reads no WhatsApp table.
 *
 * support_inbox_threads carries no mailbox column (DDL is blocked, Law 8), so a
 * thread's mailbox is derived from its messages: `gmail` on the message rows is
 * Samreen's Gmail, NULL is support@ on GoDaddy. A thread with messages in both
 * belongs to whichever its latest message came from, so it appears exactly once.
 */
export async function loadMailThreads(
  viewerEmail: string | null | undefined,
  mailbox: MailBox,
): Promise<ChannelThread[]> {
  const db = createAdminClient()
  const scope = await laneScopeFor(viewerEmail)
  const { byEmail, toPrimary } = await vendorIndex(db)
  const doneMarks = await loadDoneMarks()

  const { data: msgs } = await db
    .from('support_inbox_messages')
    .select('id, thread_id, direction, body_text, body_html, created_at, received_at, mailbox, sent_by')
    .order('created_at', { ascending: false })
    .limit(4000)

  // No content strip here either, for the same reason as the WhatsApp loader:
  // once a thread has passed the VENDOR-level gate below, the viewer sees all of
  // it. Stripping mid-thread previously rewrote last_preview and
  // last_message_at to an older message, so the list quietly disagreed with the
  // conversation it linked to.
  const rows = (msgs || []) as Array<{
    id: string; thread_id: string; direction: 'in' | 'out'; body_text: string | null
    body_html: string | null
    created_at: string; received_at: string | null; mailbox: string | null; sent_by: string | null
  }>

  // Newest-first, so the first message seen for a thread decides its mailbox.
  const owner = new Map<string, MailBox>()
  const latest = new Map<string, typeof rows[number]>()
  const lastInbound = new Map<string, string>()
  const lastHumanOut = new Map<string, string>()
  for (const m of rows) {
    const box: MailBox = m.mailbox === 'gmail' ? 'gmail' : 'support'
    if (!owner.has(m.thread_id)) { owner.set(m.thread_id, box); latest.set(m.thread_id, m) }
    if (m.direction === 'in' && !lastInbound.has(m.thread_id)) lastInbound.set(m.thread_id, m.created_at)
    if (m.direction === 'out' && m.sent_by && !lastHumanOut.has(m.thread_id)) lastHumanOut.set(m.thread_id, m.created_at)
  }

  const wanted = [...owner.entries()].filter(([, b]) => b === mailbox).map(([id]) => id)
  if (!wanted.length) return []

  const { data: threadRows } = await db
    .from('support_inbox_threads')
    .select('id, peer_email, peer_name, subject, status, unread_count, last_inbound_at, last_handled_at, vendor_application_id')
    .in('id', wanted.slice(0, 1000))

  const out: ChannelThread[] = []
  for (const t of (threadRows || []) as Array<{
    id: string; peer_email: string | null; peer_name: string | null; subject: string | null
    status: string | null; unread_count: number | null; last_inbound_at: string | null
    last_handled_at: string | null; vendor_application_id: string | null
  }>) {
    const vendor = t.peer_email ? byEmail.get(t.peer_email.toLowerCase()) : undefined
    const appId = toPrimary(t.vendor_application_id) || vendor?.id || null
    if (scope.blocks({ email: t.peer_email, applicationId: appId })) continue

    const newest = latest.get(t.id)
    const inAt = lastInbound.get(t.id) || t.last_inbound_at
    const outAt = lastHumanOut.get(t.id)
    out.push({
      id: `mail:${t.id}`,
      channel: mailbox,
      peer_name: t.peer_name || vendor?.contact_name || null,
      business_name: vendor?.business_name ?? null,
      phone: vendor?.phone ?? null,
      email: t.peer_email,
      application_id: appId,
      subject: t.subject,
      last_message_at: newest?.created_at || t.last_inbound_at,
      // Outbound mail we send is HTML-only, so body_text is empty and the row
      // read as a bare "You:" with nothing after it. Fall back to the HTML with
      // tags stripped, then to the subject, so a preview is never blank.
      last_preview: (mailPreview(newest?.body_text, newest?.body_html) || t.subject || '').slice(0, 120),
      last_direction: newest?.direction ?? null,
      unread: (t.unread_count ?? 0) > 0,
      // A human owes a reply when the newest inbound is newer than the newest
      // HUMAN outbound. Derived from real message direction, never from
      // unread_count: reading a thread used to mark it answered and evict it
      // from the queue with the customer still waiting.
      // canPin keeps newsletters and no-reply senders OUT of the pin while
      // leaving them in the list. Without it 37 of 45 Gmail threads pinned as
      // "waiting on a person", which is a queue nobody can read. A thread that
      // resolves to a vendor always pins, whatever their address looks like.
      bot_paused: false,   // no bot answers email; the field exists for one shared list shape
      needs_response:
        t.status !== 'resolved' &&
        !!inAt && (!outAt || new Date(outAt) < new Date(inAt)) &&
        canPin({ email: t.peer_email, application_id: appId, phone: vendor?.phone ?? null }) &&
        !isCleared(doneMarks.get(`mail:${t.id}`), inAt),
    })
  }

  return sortPinned(out)
}

/** Unresolved first, then newest. The pin IS the queue. */
export function sortPinned(rows: ChannelThread[]): ChannelThread[] {
  return rows.sort((a, b) => {
    if (a.needs_response !== b.needs_response) return a.needs_response ? -1 : 1
    return new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime()
  })
}
