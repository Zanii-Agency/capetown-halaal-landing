/**
 * Admin outbound reply on a unified-inbox thread.
 *
 * POST /api/admin/inbox/reply
 *   body:
 *     {
 *       thread_id: string,
 *       mode?: 'text' | 'template',          // default 'text'
 *       // text mode:
 *       body?: string,
 *       subject?: string,                    // mail only
 *       // template mode:
 *       template_key?: string,
 *       params?: Record<string,string>,
 *       // misc:
 *       mark_done?: boolean,
 *     }
 *
 * Routing:
 *   - wa  + text     -> sendText() to thread.thread_key (E.164 phone)
 *   - wa  + template -> sendTemplate() with params from WA_META_TEMPLATES
 *   - mail + text     -> Resend, subject + body, reply-to support@youngatheart
 *   - mail + template -> Resend with rendered subject + body from MAIL_TEMPLATES
 *
 * Side effects (in addition to actual send):
 *   - inserts an outbound row in wa_messages or mail_messages
 *   - updates wa_threads.last_handled_at = now
 *   - mark_done flips wa_threads.status = 'done'
 *
 * Bot handover marker NOT cleared here. Use POST /api/admin/inbox/release.
 *
 * Stream-D delta on top of Stream-C:
 *   - actually fires the send (Stream-C only queued rows)
 *   - supports template mode (Meta WA + mail templates)
 *   - bulk callers should hit this endpoint per thread with pacing (the
 *     client-side bulk bar paces with a small delay to respect Resend / Meta
 *     rate limits)
 */

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendText, sendTemplate, toE164 } from '@/lib/whatsapp'
import { sendEmail } from '@/lib/email/resend'
import { findWaTemplate, buildWaTemplateParams } from '@/lib/templates/wa-meta'
import { findMailTemplate, renderMailTemplate, validateMailTemplate } from '@/lib/mail/templates'
import { requireOperator } from '@/lib/admin-rbac'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Mode = 'text' | 'template'

interface ReplyBody {
  thread_id: string
  mode?: Mode
  body?: string
  subject?: string
  template_key?: string
  params?: Record<string, string>
  mark_done?: boolean
}

function makeMessageId(threadId: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `<${threadId}.${Date.now()}.${rand}@youngatheart.co.za>`
}

export async function POST(req: Request) {
  // SENDS WhatsApp/email + writes message rows + mutates threads. Owner/operator.
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  const session = { userId: gate.user.id, email: gate.adminUser.email ?? '' }

  let payload: ReplyBody
  try {
    payload = (await req.json()) as ReplyBody
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const { thread_id, mark_done } = payload
  const mode: Mode = payload.mode ?? 'text'
  if (!thread_id) {
    return NextResponse.json({ error: 'thread_id required' }, { status: 400 })
  }
  if (mode === 'text' && !(payload.body?.trim())) {
    return NextResponse.json({ error: 'body required for text mode' }, { status: 400 })
  }
  if (mode === 'template' && !payload.template_key) {
    return NextResponse.json({ error: 'template_key required for template mode' }, { status: 400 })
  }

  const supabase = createAdminClient()

  const { data: threadRows, error: threadErr } = (await supabase
    .from('wa_threads')
    .select('id, thread_key, channel, status')
    .eq('id', thread_id)
    .limit(1)) as unknown as {
    data: Array<{
      id: string
      thread_key: string
      channel: 'wa' | 'mail'
      status: string
    }> | null
    error: { message: string } | null
  }

  if (threadErr || !threadRows || threadRows.length === 0) {
    return NextResponse.json({ error: 'thread not found' }, { status: 404 })
  }
  const thread = threadRows[0]
  const now = new Date().toISOString()

  // -- WhatsApp path --
  if (thread.channel === 'wa') {
    const phone = toE164(thread.thread_key)

    if (mode === 'text') {
      const text = (payload.body ?? '').trim()
      try {
        const res = await sendText(phone, text)
        await supabase.from('wa_messages').insert({
          direction: 'out',
          wa_phone: phone.replace(/^\+/, ''),
          body: text,
          status: res.skipped ? 'failed' : 'sent',
          provider_message_id: res.messageId || null,
          error: res.skipped || null,
          metadata: { thread_id: thread.id, sent_by: session.userId, mode },
        })
        if (res.skipped) {
          return NextResponse.json({ ok: false, error: `send blocked: ${res.skipped}` }, { status: 422 })
        }
      } catch (e) {
        const msg = (e as Error).message
        await supabase.from('wa_messages').insert({
          direction: 'out',
          wa_phone: phone.replace(/^\+/, ''),
          body: text,
          status: 'failed',
          error: msg,
          metadata: { thread_id: thread.id, sent_by: session.userId, mode },
        })
        return NextResponse.json({ error: msg }, { status: 500 })
      }
    } else {
      const spec = findWaTemplate(payload.template_key!)
      if (!spec) {
        return NextResponse.json({ error: 'unknown wa template' }, { status: 400 })
      }
      const built = buildWaTemplateParams(spec, payload.params ?? {})
      if (!built.ok) {
        return NextResponse.json({ error: built.error }, { status: 400 })
      }
      try {
        const res = await sendTemplate(phone, spec.key, built.ordered, {
          lang: spec.lang,
          category: spec.category === 'authentication' ? 'utility' : spec.category,
        })
        await supabase.from('wa_messages').insert({
          direction: 'out',
          wa_phone: phone.replace(/^\+/, ''),
          template_name: spec.key,
          category: spec.category,
          body: spec.previewBody,
          status: res.skipped ? 'failed' : 'sent',
          provider_message_id: res.messageId || null,
          error: res.skipped || null,
          metadata: { thread_id: thread.id, sent_by: session.userId, mode, params: payload.params ?? {} },
        })
        if (res.skipped) {
          return NextResponse.json({ ok: false, error: `template blocked: ${res.skipped}` }, { status: 422 })
        }
      } catch (e) {
        const msg = (e as Error).message
        await supabase.from('wa_messages').insert({
          direction: 'out',
          wa_phone: phone.replace(/^\+/, ''),
          template_name: spec.key,
          category: spec.category,
          status: 'failed',
          error: msg,
          metadata: { thread_id: thread.id, sent_by: session.userId, mode },
        })
        return NextResponse.json({ error: msg }, { status: 500 })
      }
    }
  } else {
    // -- Mail path --
    let subject = (payload.subject ?? '').trim() || 'Re: your message'
    let body = (payload.body ?? '').trim()

    if (mode === 'template') {
      const spec = findMailTemplate(payload.template_key!)
      if (!spec) {
        return NextResponse.json({ error: 'unknown mail template' }, { status: 400 })
      }
      const v = validateMailTemplate(spec.key, payload.params ?? {})
      if (!v.ok) {
        return NextResponse.json({ error: `missing required fields: ${v.missing.join(', ')}` }, { status: 400 })
      }
      const rendered = renderMailTemplate(spec.key, payload.params ?? {})
      subject = rendered.subject
      body = rendered.body
    }

    try {
      const result = await sendEmail({ to: thread.thread_key, subject, text: body })
      const status = result.ok ? 'sent' : 'failed'
      const { error } = await supabase.from('mail_messages').insert({
        thread_id: thread.id,
        message_id: makeMessageId(thread.id),
        from_address: 'support@youngatheart.co.za',
        from_name: 'Young at Heart Festival',
        to_address: thread.thread_key,
        subject,
        body,
        direction: 'outbound',
        sent_by: session.userId,
        received_at: now,
        delivery_status: status,
        delivery_error: result.ok ? null : result.error ?? null,
      })
      if (error) {
        // Surface the insert failure but the send already happened. Don't 500
        // because that would let the operator retry and double-send.
        console.error('[inbox/reply] mail_messages insert failed:', error.message)
      }
      if (!result.ok) {
        return NextResponse.json({ error: result.error ?? 'mail send failed' }, { status: 500 })
      }
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 })
    }
  }

  // Thread bookkeeping (shared)
  const update: Record<string, unknown> = {
    last_handled_at: now,
    updated_at: now,
  }
  if (mark_done) update.status = 'done'

  const { error: upErr } = await supabase
    .from('wa_threads')
    .update(update)
    .eq('id', thread.id)

  if (upErr) {
    return NextResponse.json({ error: `thread update: ${upErr.message}` }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    thread_id: thread.id,
    handled_at: now,
    status: mark_done ? 'done' : thread.status,
    mode,
  })
}
