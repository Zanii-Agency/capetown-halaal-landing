// Mirror every outbound transactional email into the Support Inbox as a proper
// THREAD message — with body — so the admin portal is a real two-way surface:
// the operator sees exactly what was sent, and when the vendor replies (the
// support-mail-fetcher cron threads inbound by peer_email), the reply lands in
// the SAME thread and a conversation can happen.
//
// WHY (2026-06-19): the Resend `email.sent` webhook already mirrors outbound
// mail, but it stores body_html/body_text = NULL — so sent rows showed in the
// Sent tab with no readable body. This writes the row ourselves at send time
// WITH the body, deduped against the webhook on message_id = `resend:<id>`.
// Whichever lands first wins; if the webhook's body-less row is already there,
// we UPDATE it to fill the body.
//
// Best-effort only: never throws into the send path. Email delivery > logging.

import { createAdminClient } from '@/lib/supabase/admin'

const SUPPORT_FROM = 'support@youngatheart.co.za'

/** Internal funnel addresses never belong in operator threads. */
function isInternalRecipient(email: string | null): boolean {
  if (!email) return true
  return /@(youngatheart\.co\.za|sinan\.agency)$/i.test(email)
}

export async function mirrorOutboundToSupportInbox(opts: {
  to: string
  subject: string
  html?: string
  text?: string
  /** Resend email id, so message_id matches the webhook's `resend:<id>` form. */
  providerMessageId?: string
  /** admin_users.id of the person who wrote it (human email, not a notice). */
  sentBy?: string | null
}): Promise<void> {
  try {
    const peerEmail = (opts.to || '').trim().toLowerCase()
    if (!peerEmail || isInternalRecipient(peerEmail)) return

    const db = createAdminClient()
    const nowIso = new Date().toISOString()
    const subject = (opts.subject || '').slice(0, 500)

    // 1. Find-or-create the thread, keyed on lowercased peer_email (same key the
    //    inbound fetcher and the webhook use, so replies thread together).
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
        // Possible race: another path created the thread. Re-read once.
        const { data: again } = await db
          .from('support_inbox_threads')
          .select('id')
          .ilike('peer_email', peerEmail)
          .maybeSingle()
        if (!again) {
          console.error('[support-mirror] thread upsert failed:', insErr?.message)
          return
        }
        threadId = (again as { id: string }).id
      } else {
        threadId = (created as { id: string }).id
      }
    }

    // 2. Insert the outbound message WITH body. Dedup on message_id against the
    //    webhook. If the webhook's body-less row already exists, fill the body.
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
      ...(opts.sentBy ? { sent_by: opts.sentBy } : {}),
    }

    const { error: msgErr } = await db.from('support_inbox_messages').insert(row)
    if (msgErr) {
      const code = (msgErr as { code?: string }).code
      if (code === '23505' && messageId) {
        // Webhook beat us to it (body-less). Backfill the body.
        await db
          .from('support_inbox_messages')
          .update({ body_text: row.body_text, body_html: row.body_html })
          .eq('message_id', messageId)
        return
      }
      console.error('[support-mirror] message insert failed:', msgErr.message)
    }
  } catch (e) {
    console.error('[support-mirror] threw (ignored):', (e as Error).message)
  }
}
