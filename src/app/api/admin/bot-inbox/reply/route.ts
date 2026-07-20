import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendText, toE164 } from '@/lib/whatsapp'
import { isAdmin } from '@/lib/bot/admins'
import { requireOperator } from '@/lib/admin-rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Role-gated: this SENDS WhatsApp / writes wa_messages. Owner/operator only.
  const gate = await requireOperator()
  if (!gate.ok) return gate.response

  const db = createAdminClient()

  const body = await req.json().catch(() => ({}))
  const to = String(body.to || '').trim()
  const text = String(body.body || '').trim()
  // channel: 'whatsapp' (default) -> send via Meta + log row.
  //          'portal'             -> log a wa_messages out row only (vendor
  //                                  sees it in the portal Inbox card, no WA
  //                                  send). Used by /admin/vendors/[id].
  const channel = String(body.channel || 'whatsapp').toLowerCase()
  if (!to || !text) return NextResponse.json({ ok: false, error: 'Missing to/body' }, { status: 400 })

  const e164 = toE164(to)
  const isAdminRecipient = isAdmin(e164)
  // wa_phone storage: admin rows store with '+', vendor rows store without '+'.
  // Match the existing convention to keep the bot-inbox + vendor-thread queries
  // working unchanged.
  const storedPhone = isAdminRecipient ? e164 : e164.replace(/^\+/, '')

  // Portal-only writes: no Meta call, just the log row. Vendor's portal Inbox
  // card picks it up via wa_messages.direction='out'.
  if (channel === 'portal') {
    const { error: insErr } = await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: storedPhone,
      body: text,
      status: 'sent',
      metadata: { sender_type: 'admin_portal' },
    })
    if (insErr) return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 })
    return NextResponse.json({ ok: true, channel: 'portal' })
  }

  // Bot-admin-only WhatsApp replies (the original inbox use case) — kept on
  // the same admin allowlist as before. Replies to vendors via WA need a
  // template (24h window), handled by other admin endpoints.
  if (!isAdminRecipient) {
    return NextResponse.json({
      ok: false,
      error: 'WhatsApp free-form replies are only allowed to bot admins inside the session window. Use channel="portal" for vendor replies.',
    }, { status: 400 })
  }

  try {
    const res = await sendText(e164, text)
    await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: storedPhone,
      body: text,
      status: res.skipped ? 'failed' : 'sent',
      provider_message_id: res.messageId || null,
      error: res.skipped || null,
    })
    if (res.skipped) {
      return NextResponse.json({ ok: false, error: 'Send blocked: ' + res.skipped }, { status: 422 })
    }
    return NextResponse.json({ ok: true, messageId: res.messageId })
  } catch (e) {
    const msg = (e as Error).message
    await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: storedPhone,
      body: text,
      status: 'failed',
      error: msg,
    })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
