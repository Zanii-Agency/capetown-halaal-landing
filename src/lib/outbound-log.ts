/**
 * Universal outbound message logging.
 *
 * Any code path that sends WhatsApp or email should log through here. The
 * helpers are idempotent (dedupe on provider_message_id) and broadcast a live
 * inbox refresh when they write a new row. This makes terminal scripts, cron
 * jobs, and admin sends visible in the inbox without every caller needing to
 * know the table shapes.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { broadcastInboxRefresh } from '@/lib/inbox-realtime'

const SUPPORT_FROM = 'support@youngatheart.co.za'

function normalizePhone(p: string): string {
  const digits = (p || '').replace(/\D/g, '')
  if (!digits) return ''
  // Local South African numbers arrive as 0821234567 or 021...; store them with
  // the country code so they match inbound Meta rows (27...) and the inbox
  // queries that look for both +27... and 27... forms.
  if (digits.startsWith('0')) return '27' + digits.slice(1)
  if (digits.length === 9) return '27' + digits
  return digits
}

/** Best-effort: never throw. Returns true if a row was inserted. */
export async function logWhatsAppOutbound(opts: {
  phone: string
  body: string
  providerMessageId?: string | null
  status?: 'sent' | 'failed' | 'skipped'
  templateName?: string | null
  metadata?: Record<string, unknown> | null
}): Promise<boolean> {
  const waPhone = normalizePhone(opts.phone)
  if (!waPhone) return false
  if (opts.status === 'skipped') return false
  try {
    const db = createAdminClient()
    const nowIso = new Date().toISOString()
    const row = {
      direction: 'out' as const,
      wa_phone: waPhone,
      body: opts.body,
      status: opts.status || 'sent',
      provider_message_id: opts.providerMessageId || null,
      metadata: opts.metadata
        ? { ...opts.metadata, auto_logged: true, ...(opts.templateName ? { template: opts.templateName } : {}) }
        : { auto_logged: true, ...(opts.templateName ? { template: opts.templateName } : {}) },
      created_at: nowIso,
    }

    // Idempotent: if the same provider message id is already logged, skip.
    if (row.provider_message_id) {
      const { data: existing } = await db
        .from('wa_messages')
        .select('id')
        .eq('provider_message_id', row.provider_message_id)
        .limit(1)
      if (existing && existing.length > 0) return false
    }

    const { error } = await db.from('wa_messages').insert(row)
    if (error) {
      const code = (error as { code?: string }).code
      if (code === '23505' && row.provider_message_id) return false
      console.warn('[outbound-log] wa insert failed:', error.message)
      return false
    }
    await broadcastInboxRefresh('outbound-log').catch(() => {})
    return true
  } catch (e) {
    console.warn('[outbound-log] wa threw:', (e as Error).message)
    return false
  }
}

/** Best-effort: never throw. Returns true if a row was inserted or updated. */
export async function logEmailOutbound(opts: {
  to: string
  subject: string
  text?: string | null
  html?: string | null
  providerMessageId?: string | null
}): Promise<boolean> {
  const peerEmail = (opts.to || '').trim().toLowerCase()
  if (!peerEmail) return false
  try {
    const db = createAdminClient()
    const nowIso = new Date().toISOString()
    const subject = (opts.subject || '').slice(0, 500)

    let threadId: string | null = null
    const { data: existing } = await db
      .from('support_inbox_threads')
      .select('id')
      .ilike('peer_email', peerEmail)
      .maybeSingle()

    if (existing) {
      threadId = (existing as { id: string }).id
      await db.from('support_inbox_threads').update({ last_handled_at: nowIso }).eq('id', threadId)
    } else {
      const { data: created, error: insErr } = await db
        .from('support_inbox_threads')
        .insert({
          peer_email: peerEmail,
          peer_name: null,
          subject,
          status: 'open',
          last_handled_at: nowIso,
          unread_count: 0,
        })
        .select('id')
        .maybeSingle()
      if (insErr || !created) {
        const { data: again } = await db
          .from('support_inbox_threads')
          .select('id')
          .ilike('peer_email', peerEmail)
          .maybeSingle()
        if (!again) {
          console.warn('[outbound-log] email thread upsert failed:', insErr?.message)
          return false
        }
        threadId = (again as { id: string }).id
      } else {
        threadId = (created as { id: string }).id
      }
    }

    const messageId = opts.providerMessageId ? `resend:${opts.providerMessageId}` : null
    const row = {
      thread_id: threadId,
      direction: 'out' as const,
      from_address: SUPPORT_FROM,
      from_name: 'Young at Heart Festival',
      to_address: peerEmail,
      subject,
      body_text: opts.text ?? null,
      body_html: opts.html ?? null,
      message_id: messageId,
      provider: 'resend' as const,
      provider_message_id: opts.providerMessageId ?? null,
      received_at: nowIso,
    }

    const { error: msgErr } = await db.from('support_inbox_messages').insert(row)
    if (msgErr) {
      const code = (msgErr as { code?: string }).code
      if (code === '23505' && messageId) {
        await db
          .from('support_inbox_messages')
          .update({ body_text: row.body_text, body_html: row.body_html })
          .eq('message_id', messageId)
        await broadcastInboxRefresh('outbound-log').catch(() => {})
        return true
      }
      console.warn('[outbound-log] email insert failed:', msgErr.message)
      return false
    }
    await broadcastInboxRefresh('outbound-log').catch(() => {})
    return true
  } catch (e) {
    console.warn('[outbound-log] email threw:', (e as Error).message)
    return false
  }
}
