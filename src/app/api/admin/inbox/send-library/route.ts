// The send library, over HTTP.
//
//   GET  ?applicationId=   -> what can be sent to this vendor right now
//   POST { applicationId, key, channel, phone|email } -> build it and send it
//
// The list and the send read the SAME registry, so the picker can never offer
// something the sender cannot produce. That is the whole point: the bot's habit
// of promising a document and delivering nothing came from the offer and the
// delivery living in different code.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { laneScopeFor } from '@/lib/inbox-lane'
import { listSendables, buildSendable } from '@/lib/inbox/send-library'
import { sendMedia, sendText, toE164 } from '@/lib/whatsapp'
import { sendEmail } from '@/lib/email/resend'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// PDF rendering uses headless chromium, which is slow on a cold start.
export const maxDuration = 120

async function gate(applicationId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, email').eq('id', user.id).maybeSingle()
  if (!adminUser) return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  // Same lane seal as every other read: a vendor outside the viewer's lane
  // cannot be listed OR sent to from here.
  const scope = await laneScopeFor(user.email)
  if (scope.blocksApplicationId(applicationId)) {
    return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  }
  return { email: (adminUser as { email?: string }).email ?? null }
}

export async function GET(req: NextRequest) {
  const applicationId = (new URL(req.url).searchParams.get('applicationId') || '').trim()
  if (!applicationId) return NextResponse.json({ items: [] })
  const g = await gate(applicationId)
  if ('error' in g) return g.error
  return NextResponse.json({ items: await listSendables(applicationId) })
}

const bodySchema = z.object({
  applicationId: z.string().uuid(),
  key: z.string().min(1).max(60),
  channel: z.enum(['whatsapp', 'email']),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(160).optional(),
})

export async function POST(req: NextRequest) {
  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'invalid body', details: e.issues }, { status: 400 })
    throw e
  }
  const g = await gate(body.applicationId)
  if ('error' in g) return g.error

  const built = await buildSendable(body.applicationId, body.key)
  // NOTHING went out. Say so plainly rather than reporting a success the vendor
  // will never see, which is the exact failure this library exists to end.
  if (!built) {
    return NextResponse.json(
      { ok: false, message: 'That could not be produced for this vendor, so nothing was sent.' },
      { status: 409 },
    )
  }

  const db = createAdminClient()

  if (body.channel === 'whatsapp') {
    if (!body.phone) return NextResponse.json({ error: 'phone required' }, { status: 400 })
    const e164 = toE164(body.phone)
    const res = built.kind === 'document'
      ? await sendMedia(e164, {
          bytes: built.bytes as Buffer,
          mimeType: built.mimeType || 'application/pdf',
          filename: built.filename || 'document.pdf',
          kind: 'document',
          caption: built.caption,
        })
      : await sendText(e164, built.caption)
    if (res.skipped) {
      return NextResponse.json({ ok: false, message: `Not sent: ${res.skipped}`, windowClosed: res.skipped.includes('window') }, { status: 409 })
    }
    await db.from('wa_messages').insert({
      direction: 'out',
      wa_phone: e164.replace(/^\+/, ''),
      body: built.caption,
      status: 'sent',
      provider_message_id: res.messageId || null,
      metadata: { sent_by: g.email, library: body.key },
    })
    return NextResponse.json({ ok: true, sent: body.key, channel: 'whatsapp' })
  }

  if (!body.email) return NextResponse.json({ error: 'email required' }, { status: 400 })
  const res = await sendEmail({
    to: body.email,
    subject: built.filename ? built.filename.replace(/\.pdf$/i, '') : 'Young at Heart Festival',
    text: built.caption,
    ...(built.kind === 'document'
      ? { attachments: [{ filename: built.filename as string, content: built.bytes as Buffer, contentType: built.mimeType }] }
      : {}),
    confirmDelivery: true,
  })
  if (!res.ok) return NextResponse.json({ ok: false, message: `Not sent: ${res.error || 'unknown'}` }, { status: 502 })
  return NextResponse.json({ ok: true, sent: body.key, channel: 'email' })
}
