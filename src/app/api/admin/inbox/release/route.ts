/**
 * Release-bot: clear the [HUMAN_HANDOVER_ON] marker on a thread so the bot
 * resumes auto-replying. This is the ONLY path that touches that marker —
 * a plain reply never clears it.
 *
 * POST /api/admin/bot-inbox/release
 *   body: { thread_id: string }
 */

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  // Mutates wa_threads (clears the human-handover marker). Owner/operator only.
  const gate = await requireOperator()
  if (!gate.ok) return gate.response

  let payload: { thread_id?: string }
  try {
    payload = (await req.json()) as { thread_id?: string }
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  if (!payload.thread_id) {
    return NextResponse.json({ error: 'thread_id required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Look up the wa_contacts row for this thread (if wa channel)
  const { data: threadRows } = (await supabase
    .from('wa_threads')
    .select('id, channel, thread_key')
    .eq('id', payload.thread_id)
    .limit(1)) as unknown as {
    data: Array<{ id: string; channel: 'wa' | 'mail'; thread_key: string }> | null
  }

  if (!threadRows || threadRows.length === 0) {
    return NextResponse.json({ error: 'thread not found' }, { status: 404 })
  }
  const thread = threadRows[0]

  if (thread.channel !== 'wa') {
    return NextResponse.json(
      { ok: true, note: 'release-bot is a no-op on mail threads (no auto-reply bot)' }
    )
  }

  // The handover marker lives on the bot side (lib/bot/handover.ts in
  // Stream-A). We delegate clearing to it when it ships, falling back to a
  // soft toggle on wa_threads.last_handled_at so the bot's pre-send gate
  // sees a fresh handled-at and resumes auto-reply.
  try {
    // Try to import the dynamic handover module if it exists. The import
    // path is lazy so we don't bind to it at typecheck time.
    type HandoverMod = { clearHandover?: (phone: string) => Promise<void> }
    let handoverMod: HandoverMod | null = null
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handoverMod = (await import('@/lib/bot/handover' as any)) as HandoverMod
    } catch {
      handoverMod = null
    }
    if (handoverMod?.clearHandover) {
      await handoverMod.clearHandover(thread.thread_key)
    }

    // Mark the thread handled-now so any wa_threads-aware gate releases.
    await supabase
      .from('wa_threads')
      .update({ last_handled_at: new Date().toISOString() })
      .eq('id', thread.id)
  } catch (e) {
    return NextResponse.json(
      { error: `release: ${(e as Error).message}` },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true, thread_id: thread.id })
}
