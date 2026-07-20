// Unified inbox bot handover — take a WhatsApp conversation off the auto-bot
// (a human will handle it) or hand it back to the bot. Writes the same
// [HUMAN_HANDOVER_ON] / [HUMAN_HANDOVER_OFF] markers the webhook reads, so the
// festival-brain stops/resumes auto-replying for this phone.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { escalateToHuman, releaseToBot } from '@/lib/bot/handover'
import { toE164 } from '@/lib/whatsapp'
import { assertRole } from '@/lib/admin-rbac'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  phone: z.string().min(5).max(30),
  action: z.enum(['take_over', 'hand_back']),
})

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, email').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Role gate: bot handover toggles a live conversation — owner/operator only.
  try {
    await assertRole(user.id, ['owner', 'operator'])
  } catch {
    return NextResponse.json({ error: 'insufficient_role' }, { status: 403 })
  }

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'invalid body', details: e.issues }, { status: 400 })
    throw e
  }

  const e164 = toE164(body.phone)
  try {
    if (body.action === 'take_over') await escalateToHuman(e164, `taken over by ${adminUser.email}`)
    else await releaseToBot(e164, `handed back by ${adminUser.email}`)
  } catch (err) {
    console.error('[inbox/handover] error', err)
    return NextResponse.json({ ok: false, message: 'Could not update handover.' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, action: body.action, botPaused: body.action === 'take_over' })
}
