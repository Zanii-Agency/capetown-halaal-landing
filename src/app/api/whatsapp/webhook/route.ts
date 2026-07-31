import { NextRequest, NextResponse, after } from 'next/server'
import {
  verifyWebhook,
  verifySignature,
  parseInbound,
  parseStatuses,
  sendText,
  toE164,
  fetchMediaBytes,
} from '@/lib/whatsapp'
import {
  recordOptOut,
  recordConsent,
  touchInbound,
  isStopKeyword,
  isStartKeyword,
} from '@/lib/wa-consent'
import { askFestivalBrain } from '@/lib/festival-brain'
import { detectHumanIntent, escalateToHuman, isInHandover, isPendingHandover, setPendingHandover } from '@/lib/bot/handover'
import { notifyOwners } from '@/lib/bot/notify'
import { resolveSwipeReplyTarget } from '@/lib/bot/swipe-reply'
import { createAdminClient } from '@/lib/supabase/admin'
import { findAdmin, isDevNumber } from '@/lib/bot/admins'
import { resolveIdentity } from '@/lib/bot/identity'
import { handleAdminMessage } from '@/lib/bot/admin-chat'
import { routeToBrain } from '@/lib/bot/brains'
import { vendorAgentEnabled, runVendorAgent } from '@/lib/bot/vendor-agent'
import { runMasterAgent } from '@/lib/bot/master-agent'
import { seeImage } from '@/lib/bot/see-image'
import { resolveVendorSession, confirmVendorVerification } from '@/lib/bot/vendor-session'
import { emailConciergeEnabled, pendingEmailForAdmin, handleEmailConfirm } from '@/lib/email-concierge'
import { broadcastInboxRefresh } from '@/lib/inbox-realtime'
import { isMaintenanceEnabled } from '@/lib/maintenance'
import { guardReply, logGuardRedaction } from '@/lib/bot/reply-guard'
import { shouldProcess } from '@/lib/brain-core/index.js'
import { isAcknowledgement } from '@/lib/bot/ack'
import { isMarker } from '@/lib/inbox/channel-threads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Raised so a deferred after() task (e.g. rendering an invoice PDF with puppeteer
// then sendMedia) has time to finish post-200. The 200 itself still returns fast;
// this only extends how long the function may keep running for the after() work.
export const maxDuration = 60

// Handover and relay alerts pass `vendorPhone` to notifyOwners, which resolves the
// vendor by last-9 and withholds from the festival owner unless she owns them
// (paid via Yoco/cash/waived). An unresolvable number reaches both, as before.

// ---------------------------------------------------------------------------
// N2: per-sender LLM rate limit.
//
// Each inbound text drops a token in a per-waId bucket. When the bucket
// exceeds LLM_MAX_PER_5MIN, we skip the festival-brain LLM call and reply
// with a cheap static line. Without this, a single spammer with one open
// session can pin Anthropic Haiku at $1-5/min unbounded.
//
// Process-local Map; resets on cold start. Fine for the single Vercel
// instance most webhook traffic hits.
// ---------------------------------------------------------------------------
const LLM_BUCKET: Map<string, { count: number; windowStart: number }> = new Map()
const LLM_MAX_PER_5MIN = 10
const LLM_WINDOW_MS = 5 * 60_000

function checkLLMBucket(waId: string): boolean {
  const now = Date.now()
  const entry = LLM_BUCKET.get(waId) ?? { count: 0, windowStart: now }
  if (now - entry.windowStart > LLM_WINDOW_MS) {
    entry.count = 0
    entry.windowStart = now
  }
  entry.count++
  LLM_BUCKET.set(waId, entry)
  // Opportunistic cleanup so the map can't grow unbounded.
  if (LLM_BUCKET.size > 1000) {
    for (const [k, v] of LLM_BUCKET) {
      if (now - v.windowStart > LLM_WINDOW_MS) LLM_BUCKET.delete(k)
    }
  }
  return entry.count <= LLM_MAX_PER_5MIN
}

// DURABLE + GLOBAL rate limit (cost-drain defense). The LLM_BUCKET Map above is
// process-local: it resets on cold start and is per-Vercel-instance, so a burst
// fanned across instances (or repeated cold starts) multiplies the per-sender
// allowance — effectively unbounded Anthropic spend. This second gate counts the
// `wa_messages` rows we already insert per inbound (no new table — DDL is blocked,
// Law 8), so the cap is durable across instances AND adds a GLOBAL circuit
// breaker against a distributed flood from many numbers. The current inbound is
// already logged before this runs, so it is included in the count.
// Fails OPEN on a DB error (the Map backstop still caps per-instance) — a DB
// hiccup must not mute the bot for everyone.
async function durableLLMRateOk(e164: string): Promise<boolean> {
  try {
    const db = createAdminClient()
    const since = new Date(Date.now() - LLM_WINDOW_MS).toISOString()
    const { count: perPhone } = await db
      .from('wa_messages')
      .select('id', { count: 'exact', head: true })
      .eq('wa_phone', e164)
      .eq('direction', 'in')
      .gte('created_at', since)
    if ((perPhone ?? 0) > LLM_MAX_PER_5MIN) {
      await logLLMThrottle(e164, perPhone ?? 0)
      return false
    }
    // Global breaker: generous env-tunable backstop, trips only on a flood.
    const globalMax = Number(process.env.LLM_GLOBAL_MAX_PER_5MIN || 500)
    const { count: globalCount } = await db
      .from('wa_messages')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'in')
      .gte('created_at', since)
    if ((globalCount ?? 0) > globalMax) {
      console.error(JSON.stringify({ at: 'webhook', event: 'llm_global_breaker_tripped', global: globalCount, globalMax }))
      return false
    }
    return true
  } catch (e) {
    console.error('[wa-webhook] durable rate check failed (allowing; Map backstop applies):', (e as Error).message)
    return true
  }
}

async function logLLMThrottle(waId: string, count: number) {
  try {
    const db = createAdminClient()
    await db.from('site_events').insert({
      session_id: 'wa-llm-throttle',
      event_type: 'wa_llm_throttled',
      path: '/api/whatsapp/webhook',
      metadata: { wa_id: waId, count, window_minutes: LLM_WINDOW_MS / 60_000, max: LLM_MAX_PER_5MIN },
    })
  } catch (e) {
    console.warn('[wa-webhook] LLM throttle log failed:', (e as Error).message)
  }
}

/**
 * Did WE ask this number something in our last message? If so, whatever comes
 * back is an answer and must be processed, even when it looks like a closer:
 * "yes" is both. Fails OPEN (returns true, meaning "assume we asked") on a DB
 * error, because a spurious reply is a far smaller failure than swallowing a
 * vendor's answer.
 */
async function weAskedSomething(e164: string): Promise<boolean> {
  try {
    const db = createAdminClient()
    const { data } = await db
      .from('wa_messages')
      // BOTH key forms. This stripped the leading '+', but wa_phone is written
      // WITH it on the modern path, so the query only ever saw a minority of
      // legacy rows. Measured on one live number: the stripped key returned an
      // approval template from weeks earlier, while the real last outbound was
      // "Here you go, jazakallah for your patience. Your contract's waiting..."
      // So the "did we just ask a question?" test was answering about the wrong
      // message, and on any number with no legacy rows it saw nothing at all and
      // answered false. Either way the acknowledgement suppression fired when it
      // should not have, and a vendor replying "yes" to "Want me to send your
      // contract?" was classified as a conversation-closer and dropped: no
      // reply, no model call, no trace. Same +27 vs 27 key fragmentation already
      // documented in tools/registry.ts.
      .select('body')
      .or(`wa_phone.eq.${e164},wa_phone.eq.${e164.replace(/^\+/, '')}`)
      .eq('direction', 'out')
      .order('created_at', { ascending: false })
      .limit(1)
    const last = (data?.[0] as { body?: string } | undefined)?.body || ''
    return /[?？]/.test(last)
  } catch (e) {
    console.warn('[wa-webhook] weAskedSomething failed (assuming we asked):', (e as Error).message)
    return true
  }
}

// ---- GET: Meta verification handshake ----
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const challenge = verifyWebhook(p.get('hub.mode'), p.get('hub.verify_token'), p.get('hub.challenge'))
  if (challenge) return new NextResponse(challenge, { status: 200 })
  return new NextResponse('Forbidden', { status: 403 })
}

// ---- POST: inbound messages + delivery statuses ----
export async function POST(req: NextRequest) {
  // Read the RAW body for signature verification (must match byte-for-byte).
  const raw = await req.text()
  if (!verifySignature(raw, req.headers.get('x-hub-signature-256'))) {
    return new NextResponse('Invalid signature', { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return new NextResponse('Bad JSON', { status: 400 })
  }

  // Log delivery statuses (fire and forget) — never blocks the 200.
  try {
    await logStatuses(parseStatuses(body))
  } catch (e) {
    console.error('wa status log error', e)
  }

  const inbound = parseInbound(body)
  for (const msg of inbound) {
    try {
      await handleInbound(msg)
    } catch (e) {
      console.error('wa inbound handler error', e)
    }
  }

  // Always 200 fast so Meta doesn't retry/penalize.
  return NextResponse.json({ ok: true })
}

// Build a human-readable handover alert: full name, business, status and the
// actual question — plus a parseable `Phone: +27…` line that the swipe-reply
// router reads back to know who to forward Samreen's reply to.
async function buildHandoverAlert(e164: string, text: string, ongoing = false): Promise<string> {
  const who = await resolveIdentity(e164)
  const brief = who.vendor
    ? `${who.name || 'Vendor'} · ${who.vendor.business_name} · ${who.vendor.status}` +
      `${who.vendor.stall ? ` · stall ${who.vendor.stall}` : ''} · pay:${who.vendor.payment_status}`
    : who.name || 'Unknown contact'
  return `${brief}${ongoing ? ' (ongoing)' : ''}\nPhone: ${e164}\nAsks: "${text.slice(0, 240)}"\n\nSwipe-reply to this message to answer them directly.`
}

async function handleInbound(msg: {
  from: string
  messageId: string
  type: string
  text: string
  name?: string
  replyToWamid?: string
  media?: { kind: 'image' | 'document' | 'video' | 'audio' | 'sticker'; id: string; mimeType?: string; filename?: string; caption?: string }
}) {
  const e164 = toE164(msg.from)

  // Brain-core webhook guard: dedup (wamid + 2s sender lock) + media-pending buffer.
  const guard = await shouldProcess("cth", e164, msg.messageId, msg.text, {
    seenByWamid: async (id) => alreadySeen(id),
    logToChat: async (_sender, _text) => {},
  }, { hasMedia: Boolean(msg.media) })
  if (guard.action !== "process") return

  // D2) DEVELOPER-ROLE ROUTING. Taona's test number is encoded as a `developer`
  // (master doctrine). A dev test must NOT pollute the real vendor inbox/data:
  // we SKIP persistence entirely (no wa_messages row, no wa_thread, no ticket
  // auto-link) so the dev conversation never appears as a real vendor thread.
  // We still run the brain so Taona can test the answer, and the reply is sent
  // with a `[DEV] ` prefix at the chokepoint so it's clearly marked. STOP/START
  // and the bot-guards wall still apply (handled inside handleDev). Dev sits
  // AFTER signature verify (POST) + dedup guard, BEFORE any persistence.
  // Admin ALWAYS wins over dev: an admin number (e.g. Taona's master number)
  // keeps full admin-chat even if it were ever added to DEV_WHATSAPP by mistake.
  if (isDevNumber(e164) && !findAdmin(e164)) {
    await handleDev(e164, msg)
    return
  }

  await logMessage({ direction: 'in', wa_phone: e164, body: msg.text, status: 'received', providerMessageId: msg.messageId, media: msg.media })

  // 1) STOP — hard opt-out, confirm once, then go silent.
  if (isStopKeyword(msg.text)) {
    await recordOptOut({ waPhone: e164, source: 'inbound' })
    // Confirmation is allowed: it's a direct reply to their inbound (service window).
    // recordOptOut set opted_out=true, so send the confirmation directly (not via gate).
    await sendRaw(e164, "You're unsubscribed. You won't get any more WhatsApp messages from Young at Heart Festival. Reply START anytime to opt back in.")
    return
  }

  // 2) START — re-opt-in.
  if (isStartKeyword(msg.text)) {
    await touchInbound(e164, msg.name)
    await recordConsent({ waPhone: e164, source: 'inbound', profileName: msg.name })
    await sendText(e164, "You're back in 🎉 You'll get Young at Heart Festival updates here. How can I help?")
    return
  }

  // 3) Normal message — opens the 24h window.
  await touchInbound(e164, msg.name)

  // 3-MAINT) Maintenance gate. Runs AFTER STOP/START (compliance preserved)
  // and AFTER message logging (audit preserved). Master (Taona) bypasses
  // entirely so testing the bot during sweep still works. Festival_owner
  // (Samreen) gets a personalized soft message. Everyone else gets the
  // generic maintenance reply with ticket purchase still pointed at the one
  // canonical ticket URL cthalaal.co.za (Doctrine Laws 3+4 stay live).
  if (isMaintenanceEnabled()) {
    const known = findAdmin(e164)
    if (known?.role === 'master') {
      // Fall through to normal flow — Taona keeps full bot access.
    } else if (known?.role === 'festival_owner') {
      const first = known.name.split(' ')[0]
      const softMsg = `Hey ${first}, quick heads-up: I'm doing a deep tune-up on the festival platform tonight. Site and portal are temporarily offline while I tighten everything. Back online by tomorrow with everything cleaner. If anything's urgent in the meantime, message Taona directly on +971501168462. Catch you on the other side.`
      const res = await sendText(e164, softMsg)
      await logMessage({
        direction: 'out',
        wa_phone: e164,
        body: softMsg,
        status: res.skipped ? 'failed' : 'sent',
        providerMessageId: res.messageId,
      })
      return
    } else {
      const genericMsg = `Hi! The Cape Town Halaal vendor portal is being tuned up tonight. Back online tomorrow. Festival tickets are still available now at cthalaal.co.za. If you started a vendor application, your progress is saved. Reply STOP to unsubscribe.`
      const res = await sendText(e164, genericMsg)
      await logMessage({
        direction: 'out',
        wa_phone: e164,
        body: genericMsg,
        status: res.skipped ? 'failed' : 'sent',
        providerMessageId: res.messageId,
      })
      return
    }
  }

  // 3-AUDIO) Voice / audio note rejection. The Meta Cloud API surfaces
  // push-to-talk voice notes and audio file uploads as `type: 'audio'`.
  // CTH does NOT transcribe. We send a single polite reply asking the user
  // to type their message and STOP. No downstream brain/handover/admin
  // routing. Order: AFTER STOP/START + dedup + maintenance (so opt-outs
  // and maintenance windows still win), BEFORE admin/handover/brain.
  if (msg.type === 'audio') {
    const rejectMsg = "Hi! Voice notes aren't supported on this number yet. Please type your message and I'll help you out."
    const res = await sendText(e164, rejectMsg)
    await logMessage({
      direction: 'out',
      wa_phone: e164,
      body: rejectMsg,
      status: res.skipped ? 'failed' : 'sent',
      providerMessageId: res.messageId,
    })
    return
  }

  // 3-REACTION) Reactions / location / contacts / system messages. These were
  // logged above (as "reacted 👍", "📍 shared a location", etc.) so the inbox
  // shows them, but there is NOTHING to auto-reply to. Return before the brain
  // and the media-ack path, which was wrongly sending "Thanks, I have your
  // document" to a thumbs-up reaction. (Taona 2026-06-29.)
  if (msg.type === 'reaction' || msg.type === 'location' || msg.type === 'contacts' || msg.type === 'system' || msg.type === 'unsupported') {
    return
  }

  // 3a) ADMIN path — bypass the festival LLM and route through the admin chat
  // handler. The handler returns either a structured reply (intent matched —
  // stats query, blast proposal, confirmation, cancellation) or an empty reply
  // (no intent matched → fall through to a one-line ack + master forward).
  const admin = findAdmin(e164)
  if (admin) {
    // 3a-SWIPE) If the admin SWIPE-REPLIED to a handover alert, route their text
    // straight to that vendor (no "to +27…" command). The alert's wamid arrives
    // as context.id; we recover the vendor phone from the logged alert body.
    if (msg.replyToWamid) {
      const target = await resolveSwipeReplyTarget(msg.replyToWamid)
      if (target) {
        const fwd = await sendText(target.vendorE164, msg.text)
        await logMessage({
          direction: 'out', wa_phone: target.vendorE164, body: msg.text,
          status: fwd.skipped ? 'failed' : 'sent', providerMessageId: fwd.messageId,
        })
        // Pin the vendor in handover so the auto-bot stays quiet while a human is
        // actively replying (otherwise the brain could answer over the operator).
        if (!fwd.skipped) {
          await escalateToHuman(target.vendorE164, 'admin swipe-reply').catch(() => {})
        }
        const who = await resolveIdentity(target.vendorE164)
        const ackName = who.vendor?.business_name || who.firstName || target.vendorE164
        const ack = fwd.skipped
          ? `⚠️ Couldn't deliver to ${ackName}: ${fwd.skipped}`
          : `✅ Sent to ${ackName}. Swipe-reply again to keep the conversation going.`
        const ar = await sendText(e164, ack)
        await logMessage({
          direction: 'out', wa_phone: e164, body: ack,
          status: ar.skipped ? 'failed' : 'sent', providerMessageId: ar.messageId,
        })
        // Cross-mirror to the OTHER support agent so both see the conversation
        // and either can pick it up. The relay body carries `Phone: +…` and the
        // 'vendor support' prefix, so it is itself a swipe-anchor — the other
        // agent can swipe-reply on it to continue answering the same vendor.
        if (!fwd.skipped) {
          try {
            await notifyOwners({
              event: 'vendor_support_message',
              body: `${admin.name} → ${ackName}\nPhone: ${target.vendorE164}\n"${msg.text.slice(0, 240)}"\n\nSwipe-reply to continue.`,
              audience: 'all',
              exclude: e164,
              // Owner sees the relay only for a vendor she owns (paid via Yoco/cash/waived).
              vendorPhone: target.vendorE164,
            })
          } catch (e) { console.error('[swipe] cross-mirror failed:', (e as Error).message) }
        }
        return
      }
    }

    // EMAIL CONCIERGE: if this admin has an email awaiting their confirm, their
    // reply (SEND / SEND: <text> / SKIP) acts on THAT email, not normal admin
    // chat. Takes priority so a "send" isn't swallowed by the chat handler.
    if (emailConciergeEnabled()) {
      try {
        const pendingEmail = await pendingEmailForAdmin(e164)
        if (pendingEmail) {
          const r = await handleEmailConfirm(pendingEmail, msg.text)
          // Only act + stop when she actually used a concierge verb (SEND/SEND:/
          // SKIP). Any other message (stats, a blast confirm, anything) falls
          // THROUGH to normal admin chat and leaves the email pending — so an
          // unrelated message can never fire an email (skeptic CRITICAL #2).
          if (r.recognized) {
            const er = await sendText(e164, r.reply)
            await logMessage({ direction: 'out', wa_phone: e164, body: r.reply, status: er.skipped ? 'failed' : 'sent', providerMessageId: er.messageId })
            // Mirror the email action to Taona (Samreen replied SEND/SKIP -> result).
            if (admin.role === 'festival_owner') {
              await mirrorToMaster(admin, `Samreen on an email: "${msg.text.slice(0, 200)}"\nBot: ${r.reply.slice(0, 500)}`)
            }
            return
          }
        }
      } catch (e) {
        console.error('[email-concierge] confirm handling failed:', (e as Error).message)
      }
    }

    const adminResult = await handleAdminMessage(admin, msg.text)
    let reply = adminResult.reply
    // MASTER BRAIN: when no rigid command matched, let Taona's ops assistant
    // answer his free-form question (vendor lookups, pipeline numbers, drafts)
    // instead of a canned hint. Read-only + master-gated (the tool wall refuses
    // any non-master caller); returns null when disabled or the LLM is
    // unavailable, so we fall through to the canned reply below.
    // The festival owner reaches the same brain over a smaller world (Taona
    // 2026-07-28: "whenever she texts the bot u an help her with info sh needs
    // as long as it deosnt open eft lane"). Her scoping is enforced inside
    // runMasterAgent and executeMasterTool, not here, so this stays a routing
    // decision and there is exactly one place the wall lives.
    if (!reply && (admin.role === 'master' || admin.role === 'festival_owner')) {
      try {
        const brain = await runMasterAgent(admin, msg.text, { history: await recentHistory(e164) })
        if (brain?.message) reply = brain.message
      } catch (e) {
        console.error('[master-brain] failed:', (e as Error).message)
      }
    }
    reply = reply ||
      (admin.role === 'festival_owner'
        ? `Got it ${admin.name.split(' ')[0]}, passed to Taona. Ask me 'stats' for live numbers, or tell me who you want to email and I'll draft it.`
        : `Logged for you, ${admin.name}. Try 'stats' or 'email approved unpaid the payment reminder'.`)
    const res = await sendText(e164, reply)
    await logMessage({
      direction: 'out',
      wa_phone: e164,
      body: reply,
      status: res.skipped ? 'failed' : 'sent',
      providerMessageId: res.messageId,
    })
    // MIRROR to Taona: he sees EVERYTHING Samreen does with the bot — her
    // command AND the bot's reply (stats, blasts, drafts, acks). Best-effort.
    if (admin.role === 'festival_owner') {
      await mirrorToMaster(admin, `Samreen: "${msg.text.slice(0, 300)}"\nBot: ${reply.slice(0, 700)}`)
    }
    return
  }

  // MEDIA INBOUND. Two separate failures lived here, both hit by one real
  // message: Zhaahira sent a screenshot of a payment link that would not open,
  // captioned "Slms the link doesn't work", and got back "got your document and
  // it is on your application."
  //
  // 1. Her CAPTION was thrown away. parseInbound already folds a media caption
  //    into msg.text, so the question was right there, but this branch tested
  //    msg.type and short-circuited before anything could read it. A captioned
  //    image is a message with a picture attached, not a silent upload.
  // 2. The IMAGE was never opened. Taona: "its suppose to scan the image
  //    quietly to understand context". So we look, and hand what we see to the
  //    agent as context rather than narrating it back at the vendor.
  //
  // Only genuinely wordless, unreadable media still gets the plain ack.
  if (msg.type !== 'text') {
    const mediaSender = await resolveIdentity(e164)
    const caption = msg.text.trim()

    const seen = msg.media?.kind === 'image'
      ? await seeImage(msg.media.id, msg.media.mimeType)
      : null

    if (seen) {
      // Context for the agent, never shown verbatim to the vendor.
      const note = seen.isPaymentProof
        ? `[They attached an image. It looks like a proof of payment: ${seen.description} Do not confirm the payment as received or settled: say it has been passed to the team to check against the account, and answer anything else they asked.]`
        : seen.isProblem
          ? `[They attached a screenshot showing a problem: ${seen.description} Help them with THIS problem directly. Do not thank them for a document.]`
          : `[They attached an image: ${seen.description}]`
      msg.text = caption ? `${caption}\n\n${note}` : note
    } else if (caption) {
      // Vision was unavailable or the format unreadable, but they still wrote
      // something. Their words alone beat a canned acknowledgement.
      msg.text = `${caption}\n\n[They also attached ${msg.media?.kind === 'image' ? 'an image' : 'a file'} which could not be read automatically.]`
    } else {
      // Nothing to go on: no words, nothing legible. The original behaviour.
      if (mediaSender.role === 'vendor' && msg.type !== 'sticker') {
        const ack = mediaSender.firstName
          ? `Thanks ${mediaSender.firstName}, got your document and it is on your application. The team will take a look.`
          : `Thanks, got your document and it is on your application. The team will take a look.`
        const res = await sendText(e164, ack)
        await logMessage({ direction: 'out', wa_phone: e164, body: ack, status: res.skipped ? 'failed' : 'sent', providerMessageId: res.messageId })
        return
      }
      await sendText(e164, "Hi! I'm the Young at Heart Festival assistant. Ask me about tickets, vendors, directions, or anything about the festival. Type 'talk to human' to reach our support team. Reply STOP to unsubscribe.")
      return
    }
    // Fall through: this is now a normal message and takes the normal path,
    // including the handover gates and the vendor agent below.
  }

  if (!msg.text.trim()) {
    await sendText(e164, "Hi! I'm the Young at Heart Festival assistant. Ask me about tickets, vendors, directions, or anything about the festival. Type 'talk to human' to reach our support team. Reply STOP to unsubscribe.")
    return
  }

  // 3a-PENDING) An unknown contact who asked for a human was asked for their
  // name + reason; THIS message is their answer. Capture it as the handover
  // context and escalate now.
  if (await isPendingHandover(e164)) {
    await escalateToHuman(e164, msg.text)
    const ack = "Thank you. I've passed this to our team and someone will WhatsApp you back here shortly."
    const res = await sendText(e164, ack)
    await logMessage({ direction: 'out', wa_phone: e164, body: ack, status: res.skipped ? 'failed' : 'sent', providerMessageId: res.messageId })
    try {
      await notifyOwners({ event: 'vendor_support_message', body: await buildHandoverAlert(e164, msg.text), audience: 'all', vendorPhone: e164 })
    } catch (e) { console.error('[bot] notifyOwners on pending handover failed:', (e as Error).message) }
    return
  }

  // 3b) HUMAN HANDOVER intent — user explicitly wants a person.
  if (detectHumanIntent(msg.text)) {
    // Unknown contacts (not a known vendor / ticket-buyer) get asked who they
    // are + what they need FIRST, so Samreen never receives a bare number with
    // no context. Known vendors/buyers are auto-enriched, so escalate at once.
    const who = await resolveIdentity(e164)
    if (who.role === 'unknown') {
      await setPendingHandover(e164)
      const ask = "Before I connect you to our team, please tell me your name and what you need help with. For example: \"I'm Aisha from Nature's Table, I need to change my stall.\""
      const askRes = await sendText(e164, ask)
      await logMessage({ direction: 'out', wa_phone: e164, body: ask, status: askRes.skipped ? 'failed' : 'sent', providerMessageId: askRes.messageId })
      return
    }
    await escalateToHuman(e164, msg.text)
    const ack = "Got it. I've passed your message to our support team. Someone will WhatsApp you back here shortly. While they're looking, keep adding context and I'll forward it through."
    const res = await sendText(e164, ack)
    await logMessage({ direction: 'out', wa_phone: e164, body: ack, status: res.skipped ? 'failed' : 'sent', providerMessageId: res.messageId })
    try {
      await notifyOwners({
        event: 'vendor_support_message',
        body: await buildHandoverAlert(e164, msg.text),
        audience: 'all',
        vendorPhone: e164,
      })
    } catch (e) { console.error('[bot] notifyOwners on handover failed:', (e as Error).message) }
    return
  }

  // 3c) ALREADY IN HANDOVER — bot stays quiet, message gets forwarded to Samreen.
  // Auto-releases after 24h of silence so the bot resumes naturally.
  if (await isInHandover(e164)) {
    try {
      await notifyOwners({
        event: 'vendor_support_message',
        body: await buildHandoverAlert(e164, msg.text, true),
        audience: 'all',
        vendorPhone: e164,
      })
    } catch (e) { console.error('[bot] notifyOwners during handover failed:', (e as Error).message) }
    // Don't auto-reply. Samreen replies through /admin/bot-inbox.
    return
  }

  // Input-shape guard: vendors' OWN WhatsApp Business autoresponders echo back
  // at us ("Thank you for contacting Frullato!", catalogue links, business
  // hours). The transcript shows ~30 such echoes; the bot was treating them as
  // real queries and replying with a confused answer (wasted LLM + a pointless
  // message into Meta's frequency cap). Detect a clear autoresponder and do NOT
  // reply (still logged on the inbound). Conservative patterns only, so a real
  // question is never suppressed.
  if (isLikelyAutoresponder(msg.text)) {
    console.log(JSON.stringify({ at: 'webhook', event: 'autoresponder_echo_suppressed', e164_last4: e164.slice(-4) }))
    return
  }

  // Let a conversation END. A vendor reacted ❤️ to her approval and typed
  // "Yeaaahh"; the bot replied "Haha, love the energy! 😄 What's got you excited
  // ...", reopening a conversation that had just closed. The system prompt
  // already forbade that and the model did it anyway, because replying is what a
  // model is for, so the decision is made here instead of being asked for.
  //
  // Gated on our OWN last message, which is the part that makes it safe: if we
  // asked something, ANY answer is real input, and "yes" is both a closer and an
  // answer. Suppression only applies when nobody is waiting on a reply.
  if (isAcknowledgement(msg.text) && !(await weAskedSomething(e164))) {
    console.log(JSON.stringify({ at: 'webhook', event: 'acknowledgement_no_reply', e164_last4: e164.slice(-4), text: msg.text.slice(0, 40) }))
    return
  }

  // Resolve who this is so every reply is personalised (vendor name, ticket
  // count, etc.). Admins are already handled above; resolution here is for
  // vendors / ticket buyers / unknowns.
  const identity = await resolveIdentity(e164)

  // NOTE: the EFT lane deliberately does NOT change the bot's replies. Vendors in
  // the lane get the normal agent/brain like everyone else (no "maintenance"
  // message). The lane only affects the PAYMENT VIEW (EFT details vs Yoco) and
  // which admin surface shows the conversation (dev /admin/eft tab vs main inbox),
  // both handled outside the bot. "Everything remains normal" on WhatsApp.

  const history = await recentHistory(e164)
  // New brain shape: pass the latest user turn as the message, prior turns as
  // history, and per-caller identity briefing as extraSystem. The brain owns
  // the system prompt, intent routing, FAQ short-circuit, and sign-off rule.
  let reply = ''
  // Slow follow-ups (e.g. render + send an invoice PDF) handed back by the brain
  // or the agent; run AFTER the 200 via after() so the response is never blocked.
  const deferredActions: Array<() => Promise<void>> = []
  // N2: per-sender LLM rate limit. If this caller has already burned 10 LLM
  // turns in the last 5 minutes, skip the Haiku call and respond with a
  // pre-written line so a spammer can't pin our Anthropic spend.
  // Two gates ANDed: the cheap process-local Map first (short-circuits the DB
  // query under normal load), then the durable + global cap. Either tripping
  // routes to the static reply, never the LLM.
  const llmAllowed = checkLLMBucket(e164) && (await durableLLMRateOk(e164))
  if (!llmAllowed) {
    await logLLMThrottle(e164, LLM_MAX_PER_5MIN + 1)

    // THIS LINE USED TO BE A LIE, AND IT REPEATED.
    //
    // Soxbox, 2026-07-26: three inbound messages in 90 seconds each got the
    // identical "A human will respond shortly", because the branch was
    // stateless (no check for whether it had just said this), self-reinforcing
    // (every inbound is logged at the top of handleInbound BEFORE the early
    // returns, so each one extended the very window that was throttling her),
    // and it notified NOBODY: no escalateToHuman, no notifyOwners, no handover
    // marker. So the sentence was false, and because no handover was opened the
    // "already in handover, stay quiet" gate above could never catch the repeat
    // either.
    //
    // Now: escalate for real, tell the team, and say it ONCE. escalateToHuman
    // writes the [HUMAN_HANDOVER_ON] marker, so every subsequent message in this
    // burst takes the quiet handover path instead of coming back here.
    try {
      await escalateToHuman(e164, 'rate limited, handed to a human')
      await notifyOwners({
        event: 'vendor_support_message',
        body: await buildHandoverAlert(e164, msg.text, false),
        audience: 'all',
        vendorPhone: e164,
      })
    } catch (e) {
      console.error('[wa-webhook] throttle escalation failed:', (e as Error).message)
    }
    reply = identity.firstName
      ? `Thanks ${identity.firstName}, I have passed this to the team and someone will come back to you here.`
      : 'Thanks, I have passed this to the team and someone will come back to you here.'
  } else {
    try {
      // Phase D (ADR-0005): when CTH_AGENT is on, vendors and unknown senders go
      // through the Sonnet tool-calling agent (session-scoped tools + email-OTP
      // step-up). ticket_buyer keeps the read-only attendee brain (ticket-resend
      // grounding); admins are handled above. Flag off = the ADR-004 mesh, unchanged.
      if (vendorAgentEnabled() && (identity.role === 'vendor' || identity.role === 'unknown')) {
        // Deterministic verification: a bare 6-digit code confirms a pending
        // step-up. Identity binding is never model-driven (invariant 3). If there
        // is no pending challenge, fall through and treat it as an ordinary message.
        const codeOnly = msg.text.trim().match(/^(\d{6})$/)
        let handled = false
        if (codeOnly) {
          const r = await confirmVendorVerification(e164, codeOnly[1])
          if (r.reason !== 'no_pending') {
            reply = r.ok
              ? "Thanks, that is you confirmed. What can I do for you?"
              : r.reason === 'expired'
                ? "That code has expired. Tell me your application email again and I'll send a fresh one."
                : r.reason === 'too_many_attempts'
                  ? 'Too many attempts. Tell me your application email again for a fresh code.'
                  : `That code was not correct.${typeof r.remaining === 'number' ? ` ${r.remaining} attempt${r.remaining === 1 ? '' : 's'} left.` : ''}`
            handled = true
          }
        }
        if (!handled) {
          const session = await resolveVendorSession(e164)
          if (msg.media) session.media = msg.media
          const out = await runVendorAgent(session, msg.text, { history })
          reply = out.message
          deferredActions.push(...out.deferred)
        }
      } else {
        // Brain mesh (ADR-004): identity-partitioned. routeToBrain sends a vendor
        // to the scoped vendor brain and a ticket_buyer / unknown to the read-only
        // attendee brain.
        const result = await routeToBrain(identity, msg.text, { history })
        reply = result.message
        if (result.deferred) deferredActions.push(result.deferred)
      }
    } catch (e) {
      console.error('brain error', e)
      reply = identity.firstName
        ? `Thanks for your message, ${identity.firstName}! Our team will get back to you. For tickets visit cthalaal.co.za`
        : 'Thanks for your message! Our team will get back to you. For tickets visit cthalaal.co.za'
    }
  }
  // OUTPUT-side PII guard (KT #114 pattern). Redact phones/emails/IDs in
  // the bot's reply that don't belong to the caller. Log redactions.
  const guarded = guardReply(reply, { identity, callerE164: e164 })
  if (guarded.redactionCount > 0) {
    await logGuardRedaction({
      callerE164: e164,
      role: identity.role,
      redactionCount: guarded.redactionCount,
      reasons: guarded.reasons,
      originalLen: reply.length,
    })
  }
  const res = await sendText(e164, guarded.reply)
  await logMessage({ direction: 'out', wa_phone: e164, body: guarded.reply, status: res.skipped ? 'failed' : 'sent', providerMessageId: res.messageId })

  // Deliver any heavy follow-up (e.g. the invoice PDF) AFTER the 200. after()
  // survives past the response on Vercel (unlike a floating promise) and runs
  // within maxDuration (raised to 60s below for the puppeteer render). Fully
  // best-effort: a failure here never affects the inbound 200 or the text reply.
  for (const run of deferredActions) {
    after(async () => {
      try { await run() } catch (e) { console.error('[wa-webhook] deferred action failed:', (e as Error).message) }
    })
  }
}

// D2) Developer-session handler. Runs the festival brain so Taona can test the
// answer, but NEVER persists (no logMessage / touchThread / ticket auto-link),
// so a dev test creates no real vendor thread or data. Every outbound is sent
// through devSend, which prepends `[DEV] ` at the chokepoint and still routes
// through sendText's bot-guards wall + consent gate. STOP/START are recognised
// so Taona can eyeball the copy, but consent state is NOT recorded (this is a
// test handset, not a real opt-out).
async function handleDev(
  e164: string,
  msg: { type: string; text: string; media?: unknown }
) {
  const devSend = (body: string) => sendText(e164, `[DEV] ${body}`)

  if (isStopKeyword(msg.text)) {
    await devSend("STOP recognised (test mode, consent not recorded). Reply START to test the opt-back-in copy.")
    return
  }
  if (isStartKeyword(msg.text)) {
    await devSend("START recognised (test mode). You're back in 🎉 How can I help?")
    return
  }

  if (msg.type !== 'text' || !msg.text.trim()) {
    await devSend("Hi! I'm the Young at Heart Festival assistant. Ask me about tickets, vendors, directions, or anything about the festival.")
    return
  }

  let reply = ''
  try {
    const result = await askFestivalBrain(msg.text, { waId: e164, history: [] })
    reply = result.message
  } catch (e) {
    console.error('[dev] brain error', e)
    reply = 'Thanks for your message! Our team will get back to you. For tickets visit cthalaal.co.za'
  }
  await devSend(reply)
}

// Forward an admin's inbound straight to the master (Taona) so he sees it
// without waiting to open /admin/bot-inbox. Best-effort: a failure here never
// blocks the 200 to Meta because the caller logs and swallows errors.
// Mirror Samreen's bot activity (her command + the bot's reply) to Taona, so he
// sees everything she does. FYI only: not logged to wa_messages (keeps his own
// inbox thread clean), and his replies are never treated as Samreen's actions.
async function mirrorToMaster(from: { role: string; name: string }, text: string) {
  if (from.role === 'master') return // don't mirror Taona's own activity to himself
  const master = findAdmin('+971501168462')
  if (!master || master.role !== 'master') return
  try {
    await sendText(master.phone, `🪞 ${from.name.split(' ')[0]}'s desk:\n${(text || '').slice(0, 900)}`)
  } catch (e) {
    console.error('mirrorToMaster error', e)
  }
}

// ---- helpers (wa_messages = existing v5 table; wamid = provider_message_id) ----

async function alreadySeen(providerMessageId: string): Promise<boolean> {
  if (!providerMessageId) return false
  const db = createAdminClient()
  const { data } = await db.from('wa_messages').select('id').eq('provider_message_id', providerMessageId).maybeSingle()
  return Boolean(data)
}

// B6: Inbound-media durability. Meta media ids are short-lived (~1h), so we copy
// the bytes into the private `vendor-docs` bucket at receipt under
// `wa-media/<mediaId>.<ext>` and return the storage path to stash in metadata.
// Strictly best-effort: any failure (fetch, upload, missing token) returns
// undefined and the caller keeps the legacy id-only behavior. Never throws.
const WA_MEDIA_BUCKET = 'vendor-docs'
const WA_MEDIA_PREFIX = 'wa-media'

function extFromMime(mime?: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  }
  if (!mime) return 'bin'
  const base = mime.split(';')[0].trim().toLowerCase()
  return map[base] || 'bin'
}

async function captureMediaToStorage(
  db: ReturnType<typeof createAdminClient>,
  media: { kind: string; id: string; mimeType?: string; filename?: string }
): Promise<string | undefined> {
  try {
    const fetched = await fetchMediaBytes(media.id)
    if (!fetched) return undefined
    const contentType = fetched.contentType || media.mimeType || 'application/octet-stream'
    const ext = extFromMime(media.mimeType || fetched.contentType)
    const path = `${WA_MEDIA_PREFIX}/${media.id}.${ext}`
    const { error } = await db.storage.from(WA_MEDIA_BUCKET).upload(path, fetched.bytes, {
      contentType,
      upsert: true,
    })
    if (error) {
      console.error('[wa-media] storage upload failed:', error.message)
      return undefined
    }
    return path
  } catch (e) {
    console.error('[wa-media] capture failed:', (e as Error).message)
    return undefined
  }
}

// Deferred (post-response) capture: fetch+upload the bytes, then PATCH the
// existing wa_messages row to add metadata.media.storage_path. Runs inside
// after() so it never blocks the webhook 200. Best-effort end to end: every
// failure (fetch null, timeout, oversized, upload error, missing row) is caught
// and logged, never thrown — the id-only row stays valid and the proxy serves
// from the live Meta id until/unless storage_path lands.
//
// CLOBBER-SAFETY: we RE-READ the row's current metadata jsonb and merge the
// storage_path into the EXISTING media object, rather than writing a fresh
// metadata literal. This preserves any other metadata fields (and any media
// fields) that may have been written in the meantime.
async function captureMediaToStorageAndPatch(
  rowId: string,
  media: { kind: string; id: string; mimeType?: string; filename?: string }
) {
  try {
    const db = createAdminClient()
    const storagePath = await captureMediaToStorage(db, media)
    // Capture skipped (oversized / timeout / fetch fail / upload fail). Leave
    // the row id-only; the proxy falls back to the Meta id. Not an error.
    if (!storagePath) return

    // Re-read the live metadata so we merge instead of overwrite.
    const { data: current } = await db
      .from('wa_messages')
      .select('metadata')
      .eq('id', rowId)
      .maybeSingle()

    const existingMeta = ((current as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>
    const existingMedia = (existingMeta.media ?? {}) as Record<string, unknown>
    const mergedMetadata = {
      ...existingMeta,
      media: { ...existingMedia, storage_path: storagePath },
    }

    const { error } = await db
      .from('wa_messages')
      .update({ metadata: mergedMetadata })
      .eq('id', rowId)
    if (error) {
      console.error('[wa-media] storage_path patch failed:', error.message)
    }
  } catch (e) {
    console.error('[wa-media] deferred capture/patch error:', (e as Error).message)
  }
}

async function logMessage(row: {
  direction: 'in' | 'out'
  wa_phone: string
  body: string
  status: string
  providerMessageId?: string
  media?: { kind: 'image' | 'document' | 'video' | 'audio' | 'sticker'; id: string; mimeType?: string; filename?: string; caption?: string }
}) {
  const db = createAdminClient()
  // Persist the media descriptor into the existing `metadata` jsonb (no DDL,
  // Doctrine Law 8). The unified inbox media proxy reads metadata.media.id to
  // fetch the bytes from the Graph API. The wamid alone CANNOT retrieve media.
  //
  // HOT-PATH FIX (B6.2, 2026-06-23): the row is INSERTED id-only (NO
  // storage_path) and that single cheap INSERT is the only thing the webhook
  // 200 waits on. The slow Meta fetch + Supabase upload (captureMediaToStorage)
  // is deferred to Next's after() so it runs AFTER the response is flushed.
  // Until the capture lands, the proxy falls back to the live Meta media id
  // (~1h TTL) — a fully working intermediate state. Once after() patches in the
  // storage_path, the proxy serves from durable storage (no expiry).
  const idOnlyMetadata = row.media
    ? { media: { kind: row.media.kind, id: row.media.id, mime_type: row.media.mimeType, filename: row.media.filename, caption: row.media.caption } }
    : null
  const { data: inserted } = await db.from('wa_messages').insert({
    direction: row.direction,
    wa_phone: row.wa_phone,
    body: row.body,
    status: row.status,
    provider_message_id: row.providerMessageId || null,
    ...(idOnlyMetadata ? { metadata: idOnlyMetadata } : {}),
  }).select('id').single()

  // Defer the slow media capture off the synchronous 200 path. after() runs
  // post-response on Vercel and survives the function (unlike a bare floating
  // promise, which Vercel kills once the response is flushed). Best-effort:
  // EVERYTHING inside is wrapped so a capture error can NEVER throw into the
  // webhook handler — the id-only row already exists and the proxy still works.
  const mediaToCapture = row.media
  const insertedId = (inserted as { id?: string } | null)?.id
  if (mediaToCapture?.id && insertedId) {
    after(async () => {
      try {
        await captureMediaToStorageAndPatch(insertedId, mediaToCapture)
      } catch (e) {
        // Defensive: captureMediaToStorageAndPatch already swallows its own
        // errors, but this outer catch guarantees after() never rejects.
        console.error('[wa-media] deferred capture failed:', (e as Error).message)
      }
    })
  }
  // Spine: keep wa_threads in lockstep with wa_messages so the admin Bot Inbox
  // can render. Prod schema is migration v9 (PK = wa_phone). Inbound bumps
  // last_inbound_at + unread_count; outbound bumps last_outbound_at and zeroes
  // unread. Best-effort: a failure here never blocks the 200 to Meta.
  try {
    await touchThread(db, row.wa_phone, row.direction)
  } catch (e) {
    console.error('wa_threads touch error', e)
  }

  // Live inbox: ping the admin inbox to refresh instantly (no PII in the ping).
  await broadcastInboxRefresh(row.direction).catch(() => {})
}

async function touchThread(
  db: ReturnType<typeof createAdminClient>,
  waPhone: string,
  direction: 'in' | 'out'
) {
  if (!waPhone) return
  const now = new Date().toISOString()
  // Read first so we can compute unread_count without race-prone increments.
  const { data: existing } = await db
    .from('wa_threads')
    .select('wa_phone,unread_count,ticket_id')
    .eq('wa_phone', waPhone)
    .maybeSingle()

  const prevUnread = (existing as { unread_count?: number; ticket_id?: string } | null)?.unread_count ?? 0
  const existingTicketId = (existing as { ticket_id?: string } | null)?.ticket_id
  const row: Record<string, unknown> = { wa_phone: waPhone }
  if (direction === 'in') {
    row.last_inbound_at = now
    row.unread_count = prevUnread + 1
  } else {
    row.last_outbound_at = now
    row.unread_count = 0
  }
  await db.from('wa_threads').upsert(row, { onConflict: 'wa_phone' })

  // Auto-link ticket if thread has no ticket_id yet
  if (!existingTicketId) {
    try {
      await autoLinkWaTicket(db, waPhone)
    } catch (e) {
      console.error('[wa-ticket] auto-link error:', (e as Error).message)
    }
  }
}

// Auto-link a WA thread to a vendor ticket by matching phone (last 9 digits).
async function autoLinkWaTicket(db: ReturnType<typeof createAdminClient>, waPhone: string) {
  const digits = waPhone.replace(/[^0-9]/g, '')
  const last9 = digits.slice(-9)
  if (last9.length < 6) return

  const { data: app } = await db
    .from('vendor_applications')
    .select('id')
    .filter('phone', 'like', `%${last9}`)
    .maybeSingle()

  if (!app) return

  // Find or create ticket
  let { data: ticket } = await db
    .from('vendor_tickets')
    .select('id')
    .eq('vendor_application_id', app.id)
    .maybeSingle()

  if (!ticket) {
    const { data: newTicket } = await db
      .from('vendor_tickets')
      .insert({ vendor_application_id: app.id, status: 'open' })
      .select('id')
      .single()
    ticket = newTicket as { id: string } | null
  }

  if (ticket) {
    await db.from('wa_threads').update({ ticket_id: ticket.id }).eq('wa_phone', waPhone)
  }
}

async function logStatuses(statuses: Array<{ messageId: string; status: string; recipient: string; errorMessage?: string }>) {
  if (!statuses.length) return
  const db = createAdminClient()
  for (const s of statuses) {
    await db
      .from('wa_messages')
      .update({ status: s.status, error: s.errorMessage || null, updated_at: new Date().toISOString() })
      .eq('provider_message_id', s.messageId)
  }
}

// Detect a vendor's own WhatsApp Business autoresponder echoing back at us, so
// the bot does not reply to a robot. Conservative: only clear automated-greeting
// phrasings, so a genuine vendor question is never suppressed.
function isLikelyAutoresponder(text: string): boolean {
  const t = (text || '').toLowerCase().trim()
  if (!t || t.length > 600) return false
  // Specific automated-greeting phrasings only, so a genuine vendor message is
  // never suppressed. Covers both "thanks" and "thank you" forms + the
  // unavailable / business-hours / auto-reply variants that were slipping
  // through and getting a (pointless) bot reply (Taona 2026-06-28).
  const AUTORESPONDER_PATTERNS = [
    /thank(s| you)( so much)? for (contacting|reaching out|getting in touch|your (message|enquiry|inquiry|order|email|patience))/,
    /this is an automat(ed|ic) (reply|message|response)/,
    /automatic reply/,
    /auto[- ]?reply/,
    /we (will|'ll|are going to|shall) (get|be|get back|be back|revert) ?(back)? to you/,
    /we (have|'ve) received your (message|enquiry|order)/,
    /your (message|enquiry) is important to us/,
    /(our|the) (business|operating|working|trading|office) hours/,
    /outside (of )?(our )?(normal |regular )?(business|office|working|trading) hours/,
    /out of (the |our )?office/,
    /away from (my|the|our) (phone|desk|office)/,
    /we (are|'re) (currently |temporarily )?(closed|away|unavailable|not available|offline)/,
    /(currently|temporarily) (closed|away|unavailable|not available|offline)/,
    /(not |un)available (to reply|to respond|at the moment|right now|at present)/,
    /not (currently )?available to reply/,
    /kindly await/,
    /we will respond (as soon as|asap|shortly|when we)/,
    /our team will (get back|respond|be in touch)/,
    /please bear with us/,
  ]
  return AUTORESPONDER_PATTERNS.some((re) => re.test(t))
}

async function recentHistory(e164: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const db = createAdminClient()
  const { data } = await db
    .from('wa_messages')
    .select('direction, body')
    // Both key forms: rows exist with and without the leading '+', and an
    // eq on one of them silently returns a partial conversation.
    .or(`wa_phone.eq.${e164},wa_phone.eq.${e164.replace(/^\+/, '')}`)
    .order('created_at', { ascending: false })
    .limit(12)
  const rows = (data as Array<{ direction: string; body: string }>) || []
  return rows
    .reverse()
    .filter((r) => r.body)
    // OUR BOOKKEEPING IS NOT THE BOT'S OWN SPEECH. [NEEDS_HUMAN],
    // [HUMAN_HANDOVER_*] and the 🛎️ owner pings were being replayed as
    // `assistant` turns, so the model read internal notes about OTHER vendors as
    // things it had itself said, and treated them as established fact. This is
    // the most likely source of the "vendor pack" it kept promising: the phrase
    // exists NOWHERE in any prompt, template or email in this repo, so it was
    // either invented once or picked up from a human-typed line in the thread,
    // and then this replay kept feeding it back until it was true by repetition.
    .filter((r) => !isMarker(r.body))
    .slice(-8)
    .map((r) => ({ role: r.direction === 'in' ? ('user' as const) : ('assistant' as const), content: r.body }))
}

// Direct send for the STOP confirmation ONLY. recordOptOut() has already set
// opted_out=true, so the normal sendText() gate would (correctly) block this.
// A single opt-out confirmation is permitted and expected, so we bypass the gate
// with a raw Graph call. Nothing else may use this path.
//
// WALL (2026-06-13): even on the gate-bypass path the bot-guards wall still
// fires. The consent gate is a routing decision (may we talk?); the wall is a
// content cleaner (is this fit to send?). Brand-leak / em-dash / urgency rules
// must apply to every byte that leaves this process, including canned strings.
async function sendRaw(e164: string, body: string) {
  let sendBody = body
  try {
    const { sanitizeReply } = await import('@/lib/bot-guards/index.js')
    const { CTH_BOT_GUARDS_CONFIG } = await import('@/lib/bot/guards-config')
    sendBody = sanitizeReply(body, CTH_BOT_GUARDS_CONFIG).body
  } catch {
    // wall must never block the send
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: e164.replace('+', ''),
        type: 'text',
        text: { preview_url: false, body: sendBody },
      }),
    })
    // Best-effort: opted_out is already persisted by recordOptOut(), so a failed
    // confirmation must NOT throw or block. Without an .ok check, a non-2xx from
    // Graph (the send silently failing) would vanish. Log it so it is observable.
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.warn('stop-confirm send non-ok:', res.status, detail)
    }
  } catch (e) {
    console.error('stop-confirm send error', e)
  }
}
