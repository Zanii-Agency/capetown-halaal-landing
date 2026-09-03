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
import { notifyApplicationDecision, type DecisionStatus } from '@/lib/applications/decision-notify'
import { confirmPayment, type PaymentMethod } from '@/lib/payments/confirm'
import { syncPortalState } from '@/lib/portal-state'
import { withAllocation, STALL_LIST } from '@/lib/stalls'
import { executeStallChangeAction } from '@/lib/stall-change-action'

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

export interface VendorAction {
  kind: 'vendor_action'
  code: string
  action: 'approve' | 'reject' | 'info' | 'paid' | 'stall' | 'msg'
  vendorId: string
  vendorName: string
  amount?: number
  method?: PaymentMethod
  stallCode?: string
  message?: string
  note?: string
  proposedAt: string
}

export interface StallChangeAction {
  kind: 'stall_change'
  code: string
  action: 'approve' | 'reject'
  vendorId: string
  vendorName: string
  changeKind: 'size' | 'move'
  tierOverride?: string
  note?: string
  proposedAt: string
}

export type PendingAction = PendingBlast | VendorAction | StallChangeAction

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

async function storePending(adminPhone: string, pending: PendingAction): Promise<void> {
  const db = createAdminClient()
  await db.from('wa_messages').insert({
    direction: 'out',
    wa_phone: adminPhone,
    body: `[PENDING_ACTION:${JSON.stringify(pending)}] (system marker)`,
    status: 'sent',
    provider_message_id: null,
  })
}

async function loadLatestPending(adminPhone: string): Promise<PendingAction | null> {
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
      const obj = JSON.parse(m[1]) as PendingAction
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

interface VendorMatch {
  id: string
  business_name: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  status: string | null
}

async function resolveVendorByQuery(query: string): Promise<VendorMatch[]> {
  const q = (query || '').trim()
  if (!q) return []
  const db = createAdminClient()
  const safe = q.replace(/[%_]/g, '')
  const like = `%${safe}%`
  const { data } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, status')
    .or(`business_name.ilike.${like},contact_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
    .limit(4)
  return (data || []) as VendorMatch[]
}

function describeVendor(v: VendorMatch): string {
  return `${v.business_name || 'Unnamed'} (${v.contact_name || 'no contact'}, ${v.email || 'no email'}, ${v.phone || 'no phone'}) [${v.id.slice(0, 8)}]`
}

async function executeVendorAction(action: VendorAction, admin: BotAdmin): Promise<string> {
  const db = createAdminClient()

  if (action.action === 'approve' || action.action === 'reject' || action.action === 'info') {
    const status: DecisionStatus = action.action === 'approve' ? 'approved' : action.action === 'reject' ? 'rejected' : 'info_requested'
    const { data: before } = await db
      .from('vendor_applications')
      .select('id, status, email, business_name, contact_name, preferred_booth_tier, phone, admin_notes')
      .eq('id', action.vendorId)
      .single()
    if (!before) return `Could not find vendor ${action.vendorId}.`
    const update: Record<string, unknown> = { status }
    if (status === 'approved') update.approved_at = new Date().toISOString()
    update.reviewed_at = new Date().toISOString()
    const { data: after, error: updErr } = await db.from('vendor_applications').update(update).eq('id', action.vendorId).select('id, status').single()
    if (updErr || !after) return `Update failed: ${updErr?.message || 'unknown'}`
    await syncPortalState(action.vendorId, db).catch((e) => console.error('[master-action] syncPortalState failed:', (e as Error).message))
    await db.from('vendor_application_events').insert({
      application_id: action.vendorId,
      event_type: status,
      before_value: { status: before.status },
      after_value: { status: after.status },
      actor_email: admin.email || null,
      actor_role: 'master',
      note: action.note || `Set via WhatsApp by ${admin.name}`,
    })
    const notify = await notifyApplicationDecision({
      admin: db,
      id: action.vendorId,
      status,
      reason: action.note || undefined,
      app: {
        email: before.email || '',
        business_name: before.business_name || '',
        contact_name: before.contact_name || '',
        preferred_booth_tier: before.preferred_booth_tier,
        phone: before.phone,
        admin_notes: before.admin_notes,
      },
    })
    return `${before.business_name || 'Vendor'} is now ${status}. Email ${notify.emailSent ? 'sent' : 'failed'}${notify.emailError ? ` (${notify.emailError})` : ''}, WhatsApp ${notify.waSent ? 'sent' : notify.waSkipped || 'not sent'}.`
  }

  if (action.action === 'paid') {
    const result = await confirmPayment({
      applicationId: action.vendorId,
      method: action.method || 'cash',
      amount: action.amount,
      providerRef: `master-${Date.now()}`,
      notes: `Marked paid by ${admin.name} via WhatsApp`,
    })
    if (!result.ok) return `Could not mark paid: ${result.error || 'unknown'}`
    return `${action.vendorName} marked paid. Amount: R${result.amount}.`
  }

  if (action.action === 'stall') {
    const code = (action.stallCode || '').toUpperCase()
    if (!STALL_LIST.some((s) => s.code === code)) return `${code} is not a valid stall code.`
    const { data: app } = await db.from('vendor_applications').select('admin_notes, business_name').eq('id', action.vendorId).single()
    if (!app) return `Vendor not found.`
    const nextNotes = withAllocation(app.admin_notes as string, code, 'allocated')
    const { error } = await db.from('vendor_applications').update({ admin_notes: nextNotes }).eq('id', action.vendorId)
    if (error) return `Stall allocation failed: ${error.message}`
    await syncPortalState(action.vendorId, db).catch((e) => console.error('[master-action] syncPortalState failed:', (e as Error).message))
    return `${app.business_name || 'Vendor'} allocated ${code}.`
  }

  if (action.action === 'msg') {
    const { data: app } = await db.from('vendor_applications').select('phone, whatsapp_number, business_name').eq('id', action.vendorId).single()
    if (!app) return `Vendor not found.`
    const phone = (app.whatsapp_number as string | null) || (app.phone as string | null)
    if (!phone) return `${app.business_name || 'Vendor'} has no phone number on file.`
    const e164 = toE164(phone)
    const res = await sendText(e164, action.message || '')
    await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: e164,
      body: action.message || '',
      status: res.skipped ? 'failed' : 'sent',
      provider_message_id: res.messageId || null,
    })
    await escalateToHuman(e164, `replied by ${admin.name} via master command`)
    if (res.skipped) return `Could not send to ${e164}: ${res.skipped}`
    return `Sent to ${app.business_name || e164}.`
  }

  return `Unknown action: ${action.action}`
}

export interface AdminChatResult {
  reply: string
  action?: 'proposed_blast' | 'executed_blast' | 'proposed_action' | 'executed_action' | 'cancelled' | 'stats' | 'none' | 'replied_to_user' | 'released_user'
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
  // Master commands like "approve Demo Halal Kitchen" must not be swallowed by
  // the confirmation regex. Bare "approve" / "CONFIRM <code>" still confirm.
  const isMasterCommand = admin.role === 'master' && /^(approve|reject|info|paid|stall|msg)\b/i.test(t)

  if ((confirmMatch || cancelMatch) && !isMasterCommand) {
    const pending = await loadLatestPending(adminPhone)
    if (!pending) {
      return { reply: "No pending action to confirm. Tell me what you'd like to do and I'll draft it first.", action: 'none' }
    }
    if (cancelMatch) {
      await consumePending(adminPhone, pending.code)
      return { reply: `Cancelled ${pending.code}. Nothing was done.`, action: 'cancelled' }
    }
    const code = confirmMatch?.[1]?.toUpperCase()
    if (code && code !== pending.code) {
      return { reply: `That code (${code}) doesn't match the pending action (${pending.code}). Reply CONFIRM ${pending.code} to execute, or CANCEL.`, action: 'none' }
    }
    await consumePending(adminPhone, pending.code)
    if (pending.kind === 'blast') {
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

    if (pending.kind === 'stall_change') {
      const result = await executeStallChangeAction({
        applicationId: pending.vendorId,
        action: pending.action,
        kind: pending.changeKind,
        tierOverride: pending.tierOverride,
        note: pending.note,
        actorEmail: admin.email || null,
        actorRole: 'master',
      })
      if (!result.ok) {
        if (result.code === 'UNRESOLVED_TIER') {
          return {
            reply: `I need a tier. "${result.requestedText}" does not resolve to one size. Reply:\nchange approve ${pending.vendorName} to <tier>\n\nAvailable tiers:\n${(result.tiers || []).map((t) => `- ${t.slug}: ${t.label} (R${t.price})`).join('\n')}`,
            action: 'none',
          }
        }
        return { reply: `Could not ${pending.action} ${pending.changeKind} change: ${result.error}`, action: 'none' }
      }
      return { reply: `${pending.vendorName} ${pending.changeKind} change ${result.status}.`, action: 'executed_action' }
    }

    const result = await executeVendorAction(pending, admin)
    return { reply: result, action: 'executed_action' }
  }

  // (2) Stats queries.
  if (/\b(how many|count|stats|status|update|summary)\b/.test(lower)) {
    const counts = await Promise.all((['pending', 'approved', 'approved_paid', 'approved_unpaid', 'rejected', 'info_requested', 'ticket_buyers'] as SegmentKey[]).map(async (k) => `${SEGMENT_LABELS[k]}: ${await segmentCount(k)}`))
    return { reply: 'Current numbers:\n\n' + counts.join('\n') + '\n\nAsk me to email any of these segments and I will draft it first.', action: 'stats' }
  }

  // (2.5) MASTER-ONLY management commands.
  if (admin.role === 'master') {
    const approveMatch = t.match(/^approve\s+(.+)$/i)
    const rejectMatch = t.match(/^reject\s+(.+)$/i)
    const infoMatch = t.match(/^info\s+(.+)$/i)
    const paidMatch = t.match(/^paid\s+(.+?)\s+R?([\d,\.]+)(?:\s+(eft|cash|manual_card|waived|yoco))?$/i)
    const stallMatch = t.match(/^stall\s+(.+?)\s+([A-Za-z]+\d+)$/i)
    const msgMatch = t.match(/^msg\s+(.+?)\s*:\s*([\s\S]+)$/i)

    const decisionMatch = approveMatch || rejectMatch || infoMatch
    if (decisionMatch) {
      const raw = decisionMatch[1]
      let vendorQuery = raw
      let note: string | undefined
      const sepIdx = raw.search(/\s+(?:because|reason:)\s+/i)
      if (sepIdx > 0) {
        vendorQuery = raw.slice(0, sepIdx).trim()
        note = raw.slice(raw.match(/\s+(?:because|reason:)\s+/)?.[0].length || 0).trim()
      }
      const matches = await resolveVendorByQuery(vendorQuery)
      if (matches.length === 0) return { reply: `No vendor matches "${vendorQuery}".`, action: 'none' }
      if (matches.length > 1) {
        return { reply: `I found ${matches.length} vendors. Which one?\n${matches.map((m, i) => `${i + 1}. ${describeVendor(m)}`).join('\n')}`, action: 'none' }
      }
      const v = matches[0]
      const action: VendorAction['action'] = approveMatch ? 'approve' : rejectMatch ? 'reject' : 'info'
      const code = shortCode()
      const pending: VendorAction = {
        kind: 'vendor_action',
        code,
        action,
        vendorId: v.id,
        vendorName: v.business_name || 'Vendor',
        note,
        proposedAt: new Date().toISOString(),
      }
      await storePending(adminPhone, pending)
      return {
        reply: `Ready to ${action} ${describeVendor(v)}${note ? ` with note: "${note}"` : ''}.\n\nReply CONFIRM ${code} to execute, or CANCEL.`,
        action: 'proposed_action',
      }
    }

    if (paidMatch) {
      const vendorQuery = paidMatch[1]
      const amount = Number(paidMatch[2].replace(/,/g, ''))
      const method = (paidMatch[3] || 'cash') as PaymentMethod
      const matches = await resolveVendorByQuery(vendorQuery)
      if (matches.length === 0) return { reply: `No vendor matches "${vendorQuery}".`, action: 'none' }
      if (matches.length > 1) {
        return { reply: `I found ${matches.length} vendors. Which one?\n${matches.map((m, i) => `${i + 1}. ${describeVendor(m)}`).join('\n')}`, action: 'none' }
      }
      const v = matches[0]
      const code = shortCode()
      const pending: VendorAction = {
        kind: 'vendor_action',
        code,
        action: 'paid',
        vendorId: v.id,
        vendorName: v.business_name || 'Vendor',
        amount,
        method,
        proposedAt: new Date().toISOString(),
      }
      await storePending(adminPhone, pending)
      return {
        reply: `Ready to mark ${describeVendor(v)} paid R${amount} via ${method}.\n\nReply CONFIRM ${code} to execute, or CANCEL.`,
        action: 'proposed_action',
      }
    }

    if (stallMatch) {
      const vendorQuery = stallMatch[1]
      const stallCode = stallMatch[2].toUpperCase()
      const matches = await resolveVendorByQuery(vendorQuery)
      if (matches.length === 0) return { reply: `No vendor matches "${vendorQuery}".`, action: 'none' }
      if (matches.length > 1) {
        return { reply: `I found ${matches.length} vendors. Which one?\n${matches.map((m, i) => `${i + 1}. ${describeVendor(m)}`).join('\n')}`, action: 'none' }
      }
      const v = matches[0]
      const code = shortCode()
      const pending: VendorAction = {
        kind: 'vendor_action',
        code,
        action: 'stall',
        vendorId: v.id,
        vendorName: v.business_name || 'Vendor',
        stallCode,
        proposedAt: new Date().toISOString(),
      }
      await storePending(adminPhone, pending)
      return {
        reply: `Ready to allocate ${stallCode} to ${describeVendor(v)}.\n\nReply CONFIRM ${code} to execute, or CANCEL.`,
        action: 'proposed_action',
      }
    }

    if (msgMatch) {
      const vendorQuery = msgMatch[1]
      const message = msgMatch[2].trim()
      const matches = await resolveVendorByQuery(vendorQuery)
      if (matches.length === 0) return { reply: `No vendor matches "${vendorQuery}".`, action: 'none' }
      if (matches.length > 1) {
        return { reply: `I found ${matches.length} vendors. Which one?\n${matches.map((m, i) => `${i + 1}. ${describeVendor(m)}`).join('\n')}`, action: 'none' }
      }
      const v = matches[0]
      const code = shortCode()
      const pending: VendorAction = {
        kind: 'vendor_action',
        code,
        action: 'msg',
        vendorId: v.id,
        vendorName: v.business_name || 'Vendor',
        message,
        proposedAt: new Date().toISOString(),
      }
      await storePending(adminPhone, pending)
      return {
        reply: `Ready to WhatsApp ${describeVendor(v)}:\n"${message}"\n\nReply CONFIRM ${code} to send, or CANCEL.`,
        action: 'proposed_action',
      }
    }

    // Stall-change approvals (size and position/move requests).
    const changeMatch = t.match(/^change\s+(approve|reject)\s+(.+?)(?:\s+to\s+(.+))?$/i)
    const moveMatch = t.match(/^move\s+(approve|reject)\s+(.+?)(?:\s+(?:because|note:)\s+(.+))?$/i)

    if (changeMatch || moveMatch) {
      const changeKind: 'size' | 'move' = changeMatch ? 'size' : 'move'
      const m = (changeMatch || moveMatch)!
      const action = m[1].toLowerCase() as 'approve' | 'reject'
      const raw = m[2]
      let vendorQuery = raw
      let note: string | undefined
      let tierOverride: string | undefined
      const sepIdx = raw.search(/\s+(?:because|note:)\s+/i)
      if (sepIdx > 0) {
        vendorQuery = raw.slice(0, sepIdx).trim()
        note = raw.slice(raw.match(/\s+(?:because|note:)\s+/)?.[0].length || 0).trim()
      }
      if (changeKind === 'size' && m[3]) tierOverride = m[3].trim()
      if (changeKind === 'move' && m[3]) note = m[3].trim()

      const matches = await resolveVendorByQuery(vendorQuery)
      if (matches.length === 0) return { reply: `No vendor matches "${vendorQuery}".`, action: 'none' }
      if (matches.length > 1) {
        return { reply: `I found ${matches.length} vendors. Which one?\n${matches.map((mm, i) => `${i + 1}. ${describeVendor(mm)}`).join('\n')}`, action: 'none' }
      }
      const v = matches[0]
      const code = shortCode()
      const pending: StallChangeAction = {
        kind: 'stall_change',
        code,
        action,
        vendorId: v.id,
        vendorName: v.business_name || 'Vendor',
        changeKind,
        tierOverride,
        note,
        proposedAt: new Date().toISOString(),
      }
      await storePending(adminPhone, pending)
      const overrideLine = tierOverride ? ` to tier "${tierOverride}"` : ''
      const noteLine = note ? ` with note: "${note}"` : ''
      return {
        reply: `Ready to ${action} ${changeKind} change for ${describeVendor(v)}${overrideLine}${noteLine}.\n\nReply CONFIRM ${code} to execute, or CANCEL.`,
        action: 'proposed_action',
      }
    }
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
      if (!last || last.kind !== 'blast') {
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

  // (5) HELP: list what the admin can do from WhatsApp.
  if (/\b(help|commands|what can you do|what can i do)\b/i.test(t)) {
    if (admin.role === 'master') {
      return {
        reply: 'Here is what you can do from WhatsApp:\n\n' +
          'VENDOR DECISIONS\n' +
          'approve <vendor>\n' +
          'reject <vendor> [because <reason>]\n' +
          'info <vendor> [because <reason>]\n\n' +
          'PAYMENT & STALL\n' +
          'paid <vendor> R<amount> [eft|cash|manual_card|waived|yoco]\n' +
          'stall <vendor> <code>\n\n' +
          'STALL CHANGES\n' +
          'change approve <vendor> [to <tier>]\n' +
          'change reject <vendor> [because <reason>]\n' +
          'move approve <vendor>\n' +
          'move reject <vendor> [because <reason>]\n\n' +
          'MESSAGING\n' +
          'msg <vendor> : <message>\n' +
          'to <+phone> <message>\n' +
          'release <+phone>\n\n' +
          'BLASTS & STATS\n' +
          'stats\n' +
          'send <segment> (approved, approved_unpaid, etc.)\n\n' +
          'Every action that changes something needs a CONFIRM <code> reply first.',
        action: 'none',
      }
    }
    return {
      reply: 'Here is what you can do from WhatsApp:\n\n' +
        'stats\n' +
        'send <segment> (approved, approved_unpaid, etc.)\n' +
        'to <+phone> <message> to reply to a vendor\n' +
        'release <+phone> to hand a conversation back to the bot\n\n' +
        'Payment numbers and vendor lists are handled by Taona while the payment period is running.',
      action: 'none',
    }
  }

  // (6) Fallthrough, let the brain answer. Signal to caller to invoke the LLM
  // with the master/festival_owner identity briefing.
  return { reply: '', action: 'none' }
}
