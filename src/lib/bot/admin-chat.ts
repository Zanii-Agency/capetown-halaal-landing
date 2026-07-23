// Admin chat handler — the brain behind Samreen's WhatsApp control surface.
// Detects intent from a free-form admin message, drafts a high-blast-radius
// action (email blast, stat query, etc.), and stores it as a PENDING ACTION
// in wa_messages with a structured marker. Next inbound from the same admin
// that starts with CONFIRM <code> executes; CANCEL drops it.
//
// State store = wa_messages.body with `[PENDING_ACTION:{json}]` prefix on an
// outbound row to that admin's phone. No DDL needed (DDL blocked on this
// Supabase project). Recover the latest pending by scanning recent outbounds.
//
// Safety: same Nisria send_newsletter pattern — high-blast actions never fire
// on a single sentence; the human gets a draft + count + explicit YES gate.

import { createAdminClient } from '@/lib/supabase/admin'
import { getEftMode } from '@/lib/eft'
import { matchSegment, segmentCount, SEGMENT_LABELS, type SegmentKey } from './segments'
import { runBlast, type BlastTemplate } from './blast'
import type { BotAdmin } from './admins'
import { sendText, toE164 } from '@/lib/whatsapp'
import { escalateToHuman } from './handover'

export interface PendingBlast {
  kind: 'blast'
  code: string // short code the admin types after CONFIRM, e.g. "RB73"
  segment: SegmentKey
  template: BlastTemplate
  subject?: string
  bodyMarkdown?: string
  estCount: number
  proposedAt: string
}

const MARKER_RE = /\[PENDING_ACTION:({.*?})\]/

function shortCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return 'B' + s
}

function templateMatch(phrase: string): BlastTemplate {
  const p = phrase.toLowerCase()
  if (/\breject|declin|unsuccessful/.test(p)) return 'application_rejected'
  if (/\bapprov|accept|welcome/.test(p)) return 'application_approved'
  if (/\binfo|missing|incomplete/.test(p)) return 'application_info_requested'
  if (/\bdelay|update/.test(p)) return 'application_delay_notice'
  return 'custom'
}

async function storePending(adminPhone: string, pending: PendingBlast): Promise<void> {
  const db = createAdminClient()
  await db.from('wa_messages').insert({
    direction: 'out',
    wa_phone: adminPhone,
    body: `[PENDING_ACTION:${JSON.stringify(pending)}] (system marker)`,
    status: 'sent',
    provider_message_id: null,
  })
}

async function loadLatestPending(adminPhone: string): Promise<PendingBlast | null> {
  const db = createAdminClient()
  const { data } = await db
    .from('wa_messages')
    .select('body, created_at')
    .eq('wa_phone', adminPhone)
    .eq('direction', 'out')
    .order('created_at', { ascending: false })
    .limit(30)
  for (const row of (data || []) as Array<{ body: string; created_at: string }>) {
    const m = (row.body || '').match(MARKER_RE)
    if (!m) continue
    try {
      const obj = JSON.parse(m[1]) as PendingBlast
      // Expire after 30 minutes — stale confirmations don't fire.
      const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000
      if (ageMin > 30) return null
      return obj
    } catch {
      continue
    }
  }
  return null
}

async function consumePending(adminPhone: string, code: string): Promise<void> {
  const db = createAdminClient()
  // Mark this pending as consumed by appending a CONSUMED tag. Idempotent.
  const { data } = await db
    .from('wa_messages')
    .select('id, body')
    .eq('wa_phone', adminPhone)
    .like('body', `%[PENDING_ACTION:%"code":"${code}"%]%`)
    .limit(5)
  for (const row of (data || []) as Array<{ id: string; body: string }>) {
    await db
      .from('wa_messages')
      .update({ body: row.body.replace('[PENDING_ACTION:', '[PENDING_ACTION_DONE:') })
      .eq('id', row.id)
  }
}

export interface AdminChatResult {
  reply: string
  action?: 'proposed_blast' | 'executed_blast' | 'cancelled' | 'stats' | 'none' | 'replied_to_user' | 'released_user'
}

// Public entrypoint — handle one inbound admin message.
export async function handleAdminMessage(admin: BotAdmin, text: string): Promise<AdminChatResult> {
  const t = text.trim()
  const lower = t.toLowerCase()
  const adminPhone = admin.phone

  // EFT-mode wall: while global EFT mode is ON, the bot must not surface payment
  // numbers, segment counts, drafts or blasts to the festival owner (Samreen).
  // Taona handles all payment ops on his side. She can still message the bot, and
  // the webhook still mirrors her message to him; this just walls the DATA and
  // action paths to a neutral reply so nothing leaks. Reverts when EFT mode is off.
  if (admin.role === 'festival_owner' && (await getEftMode())) {
    return {
      reply: `Thanks ${admin.name.split(' ')[0]}. While the payment period is running, Taona is handling all the payment numbers, vendor lists and emails directly, so I am keeping those on his side for now. I have passed your message on to him, and I am here for anything else.`,
      action: 'none',
    }
  }

  // (1) Confirmation / cancellation of a pending action.
  const confirmMatch = t.match(/^(?:confirm|yes\s+send|approve)\s*([A-Z0-9]{3,8})?/i)
  const cancelMatch = /^(?:cancel|no|abort|stop)\b/i.test(t)

  if (confirmMatch || cancelMatch) {
    const pending = await loadLatestPending(adminPhone)
    if (!pending) {
      return { reply: "No pending action to confirm. Tell me what you'd like to send and I'll draft it first.", action: 'none' }
    }
    if (cancelMatch) {
      await consumePending(adminPhone, pending.code)
      return { reply: `Cancelled ${pending.code}. Nothing was sent.`, action: 'cancelled' }
    }
    const code = confirmMatch?.[1]?.toUpperCase()
    if (code && code !== pending.code) {
      return { reply: `That code (${code}) doesn't match the pending action (${pending.code}). Reply CONFIRM ${pending.code} to send, or CANCEL.`, action: 'none' }
    }
    await consumePending(adminPhone, pending.code)
    const result = await runBlast({
      segment: pending.segment,
      template: pending.template,
      subject: pending.subject,
      bodyMarkdown: pending.bodyMarkdown,
    })
    return {
      reply: `Done. Sent ${result.sent}/${result.attempted} (${result.failed} failed)${result.failed ? '. First few failures: ' + result.errors.slice(0, 3).map((e) => e.email).join(', ') : ''}.`,
      action: 'executed_blast',
    }
  }

  // (2) Stats queries.
  if (/\b(how many|count|stats|status|update|summary)\b/.test(lower)) {
    const counts = await Promise.all((['pending', 'approved', 'approved_paid', 'approved_unpaid', 'rejected', 'info_requested', 'ticket_buyers'] as SegmentKey[]).map(async (k) => `${SEGMENT_LABELS[k]}: ${await segmentCount(k)}`))
    return { reply: 'Current numbers:\n\n' + counts.join('\n') + '\n\nAsk me to email any of these segments and I will draft it first.', action: 'stats' }
  }

  // (3) Email/blast intent detection.
  const wantsToSend = /\b(send|email|blast|message|remind|notify|tell)\b/.test(lower)
  const seg = matchSegment(lower)
  if (wantsToSend && seg) {
    const tpl = templateMatch(lower)
    const count = await segmentCount(seg)
    if (count === 0) {
      return { reply: `Nobody matches "${SEGMENT_LABELS[seg]}" right now, nothing to send.`, action: 'none' }
    }
    if (tpl === 'custom') {
      return {
        reply: `Got it, you want to email ${count} recipient${count === 1 ? '' : 's'} in: ${SEGMENT_LABELS[seg]}. I don't have a matching standard template, so please send me the SUBJECT and BODY in your next message, like:\n\nSUBJECT: ...\nBODY: ...\n\nThen I'll draft the send and ask you to confirm.`,
        action: 'none',
      }
    }
    const code = shortCode()
    const pending: PendingBlast = {
      kind: 'blast',
      code,
      segment: seg,
      template: tpl,
      estCount: count,
      proposedAt: new Date().toISOString(),
    }
    await storePending(adminPhone, pending)
    return {
      reply: `Ready to send the ${tpl.replace(/_/g, ' ')} template to ${count} recipient${count === 1 ? '' : 's'} in "${SEGMENT_LABELS[seg]}".\n\nReply CONFIRM ${code} to send, or CANCEL to drop it. Expires in 30 minutes.`,
      action: 'proposed_blast',
    }
  }

  // (4) Free-form SUBJECT/BODY for a custom blast — only meaningful if there's
  // already a pending segment-only request waiting.
  if (/^subject\s*[:\-]/i.test(t)) {
    const subjectMatch = t.match(/subject\s*[:\-]\s*([^\n]+)/i)
    const bodyMatch = t.match(/body\s*[:\-]\s*([\s\S]+)/i)
    const subject = subjectMatch?.[1]?.trim()
    const body = bodyMatch?.[1]?.trim()
    if (subject && body) {
      // Look up the latest non-confirmed pending; upgrade it to custom with this content.
      const last = await loadLatestPending(adminPhone)
      if (!last) {
        return { reply: 'I have no pending segment to attach this subject/body to. First tell me who to email, then send SUBJECT/BODY.', action: 'none' }
      }
      const code = shortCode()
      const pending: PendingBlast = { ...last, code, template: 'custom', subject, bodyMarkdown: body, proposedAt: new Date().toISOString() }
      await storePending(adminPhone, pending)
      return {
        reply: `Drafted. Sending to ${pending.estCount} recipient${pending.estCount === 1 ? '' : 's'} in "${SEGMENT_LABELS[pending.segment]}".\n\nSUBJECT: ${subject}\n\nReply CONFIRM ${code} to send, or CANCEL.`,
        action: 'proposed_blast',
      }
    }
  }

  // (4.5) DIRECT REPLY TO A USER. Admin types: "to +27721234567 hello there".
  // The bot relays that exact text to the named user via the WABA endpoint and
  // logs it on the user's thread so /admin/bot-inbox shows it inline. Lets
  // Samreen handle multiple cases from her own WhatsApp without touching the
  // admin portal. Keeps the handover marker on so the bot stays quiet.
  const toMatch = t.match(/^to\s+(\+?\d{8,16})\s+([\s\S]+)$/i)
  if (toMatch) {
    const targetRaw = toMatch[1]
    const message = toMatch[2].trim()
    if (!message) {
      return { reply: 'Add the message after the number. Example:\n\nto +27721234567 Hi Salma, pay at cthalaal.co.za/exhibitor/portal/payments', action: 'none' }
    }
    try {
      const targetE164 = toE164(targetRaw)
      const res = await sendText(targetE164, message)
      const db = createAdminClient()
      await db.from('wa_messages').insert({
        direction: 'out',
        wa_phone: targetE164,
        body: message,
        status: res.skipped ? 'failed' : 'sent',
        provider_message_id: res.messageId || null,
      })
      await escalateToHuman(targetE164, `replied by ${admin.name}`)
      if (res.skipped) return { reply: `Could not send to ${targetE164}, reason: ${res.skipped}.`, action: 'none' }
      return {
        reply: `Sent to ${targetE164}. The user sees a normal WhatsApp message from the festival bot. I'll stay out of your way for that conversation. Type "release ${targetE164}" to hand it back to the auto-bot, or it auto-releases after 24h of silence.`,
        action: 'replied_to_user',
      }
    } catch (e) {
      return { reply: `Send failed: ${(e as Error).message}`, action: 'none' }
    }
  }

  // (4.6) RELEASE: hand a user back to the auto-bot. "release +27721234567"
  const relMatch = t.match(/^release\s+(\+?\d{8,16})\s*$/i)
  if (relMatch) {
    const targetE164 = toE164(relMatch[1])
    const { releaseToBot } = await import('./handover')
    await releaseToBot(targetE164, `released by ${admin.name}`)
    return { reply: `Released ${targetE164} back to the auto-bot.`, action: 'released_user' }
  }

  // (5) Fallthrough, let the brain answer. Signal to caller to invoke the LLM
  // with the master/festival_owner identity briefing.
  return { reply: '', action: 'none' }
}
