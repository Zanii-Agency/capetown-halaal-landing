// Mark a conversation done, or reopen it.
//
// The unpin the queue never had. `needs_response` was purely derived and the
// only thing that cleared it was a human reply carrying metadata.sent_by, which
// 18 of 204 threads have ever had — so the queue filled and never drained.
//
// Auth mirrors the sibling channel routes. The thread id is opaque here on
// purpose: it is whatever the list already uses ("wa:27…" / "mail:<uuid>"), so
// this endpoint needs no knowledge of channels and cannot be used to address
// anything the caller could not already see in their own list.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { setThreadDone } from '@/lib/inbox/queue-state'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  threadId: z.string().min(1).max(120),
  done: z.boolean(),
})

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id, email').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: 'invalid body', details: e.issues }, { status: 400 })
    throw e
  }

  await setThreadDone(body.threadId, body.done, (adminUser as { email?: string }).email ?? null)
  return NextResponse.json({ ok: true, threadId: body.threadId, done: body.done })
}
