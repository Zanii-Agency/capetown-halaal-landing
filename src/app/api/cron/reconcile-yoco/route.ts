/**
 * GET /api/cron/reconcile-yoco
 *
 * Recovery for a missed Yoco webhook (KT #206651 P0.4). The webhook is the only
 * live-status writer and retries at most 3 times; if all fail (cold start, deploy
 * window, DB blip) a genuinely-paid vendor stays "unpaid" forever and keeps
 * getting dunning reminders while charged. This cron re-checks every stored Yoco
 * checkout ref against Yoco's live API and calls the SAME idempotent
 * confirmPayment() the webhook uses — so it is a second safe caller of the one
 * authority, never a parallel writer.
 *
 * Ports scripts/reconcile-yoco.mjs (--auto) into a fail-closed cron endpoint.
 * Auth: Vercel cron POSTs Authorization: Bearer ${CRON_SECRET}; operator can
 * trigger manually with the same header. Idempotent: already-paid rows are skipped.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { parsePortalState } from '@/lib/portal-state'
import { confirmPayment } from '@/lib/payments/confirm'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

async function yocoGet(id: string, key: string): Promise<Record<string, unknown>> {
  const r = await fetch(`https://payments.yoco.com/api/checkouts/${id}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: 'no-store',
  })
  if (!r.ok) throw new Error(`Yoco ${id}: HTTP ${r.status}`)
  return (await r.json()) as Record<string, unknown>
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const key = (process.env.YOCO_SECRET_KEY || '').trim()
  if (!key) return NextResponse.json({ error: 'YOCO_SECRET_KEY missing' }, { status: 500 })

  const db = createAdminClient()

  // Pull every application that has a Yoco checkout ref in portal state.
  const { data } = await db
    .from('vendor_applications')
    .select('id, admin_notes')
    .ilike('admin_notes', '%PORTAL:%')

  const queue: Array<{ ref: string; appId: string; cachedPaid: boolean }> = []
  for (const a of (data as Array<{ id: string; admin_notes: string | null }>) || []) {
    const s = parsePortalState(a.admin_notes || '')
    const ref = s.payment?.provider_ref
    if (ref && ref.startsWith('ch_')) {
      queue.push({ ref, appId: a.id, cachedPaid: s.payment?.status === 'paid' })
    }
  }

  let flipped = 0
  let alreadyPaid = 0
  let skipped = 0
  let errors = 0
  for (const { ref, appId, cachedPaid } of queue) {
    // Skip refs our DB already shows paid — confirmPayment is idempotent, but
    // avoiding the Yoco round-trip keeps the cron cheap.
    if (cachedPaid) { alreadyPaid++; continue }
    try {
      const ck = await yocoGet(ref, key)
      const status = ck.status as string | undefined
      const metaAppId = (ck.metadata as { applicationId?: string } | undefined)?.applicationId || appId
      if (status !== 'completed') { skipped++; continue }
      const amount = ((ck.amount as number) ?? 0) / 100
      const out = await confirmPayment({ applicationId: metaAppId, method: 'yoco', amount, providerRef: ref })
      if (out.alreadyPaid) alreadyPaid++
      else if (out.ok) flipped++
      else errors++
    } catch (e) {
      console.error('[reconcile-yoco]', ref, (e as Error).message)
      errors++
    }
  }

  const summary = { checked: queue.length, flipped, alreadyPaid, skipped, errors }
  try {
    await db.from('site_events').insert({
      session_id: 'cron:reconcile-yoco',
      event_type: 'cron_reconcile_yoco',
      path: '/api/cron/reconcile-yoco',
      metadata: { ...summary, at: new Date().toISOString() },
    })
  } catch { /* best-effort cron-health log */ }

  return NextResponse.json({ ok: true, ...summary })
}
