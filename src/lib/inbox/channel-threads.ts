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
import { laneScopeFor, hidesEftContent, stripEftMessages } from '@/lib/inbox-lane'
import { withoutMerged } from '@/lib/merge'
import { BOT_ADMINS } from '@/lib/bot/admins'

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
}

const phoneKey = (p: string | null | undefined) => (p || '').replace(/\D/g, '').slice(-9)
const norm = (p: string) => p.replace(/^\+/, '')

/** The master line(s). Operator threads are never customer conversations. */
const MASTER_PHONES = new Set(BOT_ADMINS.filter((a) => a.role === 'master').map((a) => phoneKey(a.phone)))

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
  const hideEft = hidesEftContent(viewerEmail)
  const { byPhone, toPrimary } = await vendorIndex(db)

  const { data: msgs } = await db
    .from('wa_messages')
    // NO read_at: that column does not exist on wa_messages, and selecting it
    // made the whole query error, so this loader silently returned ZERO threads.
    // Unread is derived from message direction below instead.
    .select('id, wa_phone, direction, body, created_at, metadata')
    .order('created_at', { ascending: false })
    .limit(4000)

  const rows = stripEftMessages(
    (msgs || []) as Array<{
      id: string; wa_phone: string; direction: 'in' | 'out'; body: string | null
      created_at: string; metadata: Record<string, unknown> | null
    }>,
    (m) => m.body,
    hideEft,
  )

  const threads = new Map<string, ChannelThread>()
  const needsHumanAt = new Map<string, string>()
  const humanReplyAt = new Map<string, string>()
  const lastInboundAt = new Map<string, string>()
  const lastOutboundAt = new Map<string, string>()

  // created_at DESC, so the FIRST time a phone is seen is its newest message.
  for (const m of rows) {
    const k = phoneKey(m.wa_phone)
    if (k.length !== 9 || MASTER_PHONES.has(k)) continue
    const vendor = byPhone.get(k)
    if (scope.blocks({ phone: m.wa_phone, applicationId: toPrimary(vendor?.id) })) continue

    if (!threads.has(k)) {
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
        last_preview: (m.body || '').slice(0, 120),
        last_direction: m.direction,
        unread: false,
        needs_response: false,
      })
    }
    if (m.direction === 'in' && !lastInboundAt.has(k)) lastInboundAt.set(k, m.created_at)
    if (m.direction === 'out' && !lastOutboundAt.has(k)) lastOutboundAt.set(k, m.created_at)
    if (/\[NEEDS_HUMAN\]/.test(m.body || '') && !needsHumanAt.has(k)) needsHumanAt.set(k, m.created_at)
    if (m.direction === 'out' && m.metadata?.sent_by && !humanReplyAt.has(k)) humanReplyAt.set(k, m.created_at)
  }

  for (const [k, t] of threads) {
    const inAt = lastInboundAt.get(k)
    const anyOut = lastOutboundAt.get(k)
    const humanOut = humanReplyAt.get(k)
    // unread: nothing at all has gone back since they wrote.
    t.unread = !!inAt && (!anyOut || new Date(anyOut) < new Date(inAt))
    // needs_response (the pin): no HUMAN has answered since they wrote. The bot
    // replying does NOT clear it, which is the point: the bot having answered is
    // frequently the reason a person is needed.
    const escalated = needsHumanAt.get(k)
    const escalationOpen = !!escalated && (!humanOut || new Date(humanOut) < new Date(escalated))
    const inboundUnanswered = !!inAt && (!humanOut || new Date(humanOut) < new Date(inAt))
    t.needs_response = escalationOpen || inboundUnanswered
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
  const hideEft = hidesEftContent(viewerEmail)
  const { byEmail, toPrimary } = await vendorIndex(db)

  const { data: msgs } = await db
    .from('support_inbox_messages')
    .select('id, thread_id, direction, body_text, created_at, received_at, mailbox, sent_by')
    .order('created_at', { ascending: false })
    .limit(4000)

  const rows = stripEftMessages(
    (msgs || []) as Array<{
      id: string; thread_id: string; direction: 'in' | 'out'; body_text: string | null
      created_at: string; received_at: string | null; mailbox: string | null; sent_by: string | null
    }>,
    (m) => m.body_text,
    hideEft,
  )

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
      last_preview: (newest?.body_text || '').slice(0, 120),
      last_direction: newest?.direction ?? null,
      unread: (t.unread_count ?? 0) > 0,
      // A human owes a reply when the newest inbound is newer than the newest
      // HUMAN outbound. Derived from real message direction, never from
      // unread_count: reading a thread used to mark it answered and evict it
      // from the queue with the customer still waiting.
      needs_response: t.status !== 'resolved' && !!inAt && (!outAt || new Date(outAt) < new Date(inAt)),
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
