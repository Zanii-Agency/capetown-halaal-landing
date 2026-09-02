// Admin-only manual payment confirmation. Used after reconciling an EFT,
// cash-at-door, or off-platform card payment against the FNB statement.
// Path mirrors the yoco webhook outcome via the shared confirmPayment helper
// so the vendor experience is identical regardless of how they paid.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { confirmPayment, type PaymentMethod } from '@/lib/payments/confirm'
import { syncPortalState } from '@/lib/portal-state'
import { assertRole } from '@/lib/admin-rbac'
import { recordAdminAction } from '@/lib/zanii-ledger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED: PaymentMethod[] = ['eft', 'cash', 'manual_card', 'waived']

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  // Role gate (B7). Marking a payment paid is a money-state mutation —
  // viewer must not be able to do this. Only owner/operator.
  let actorRole: string | null = null
  try {
    actorRole = await assertRole(user.id, ['owner', 'operator'])
  } catch {
    return NextResponse.json({ ok: false, error: 'insufficient_role' }, { status: 403 })
  }

  const db = createAdminClient()

  const body = await req.json().catch(() => ({}))
  const applicationId = String(body.applicationId || '').trim()
  const method = String(body.method || '').trim() as PaymentMethod
  const amount = typeof body.amount === 'number' ? body.amount : undefined
  const providerRef = body.providerRef ? String(body.providerRef).trim().slice(0, 80) : undefined
  const reason = body.reason ? String(body.reason).trim().slice(0, 500) : undefined
  const silent = !!body.silent

  if (!applicationId) return NextResponse.json({ ok: false, error: 'Missing applicationId' }, { status: 400 })
  if (!ALLOWED.includes(method)) {
    return NextResponse.json({ ok: false, error: `method must be one of: ${ALLOWED.join(', ')}` }, { status: 400 })
  }

  // Audit H1: clamp amount to a sane range so a fumbled admin call can't
  // record a negative number or an absurd value that corrupts revenue totals.
  // Largest legitimate stall fee is R12,000 plus electricity add-ons. R100,000
  // is a generous upper bound; anything beyond it is a typo or worse.
  if (amount !== undefined && (!Number.isFinite(amount) || amount < 0 || amount > 100_000)) {
    return NextResponse.json({ ok: false, error: 'amount must be between 0 and 100000' }, { status: 400 })
  }

  // Waiving a fee deserves an explicit written reason that gets logged so
  // there is an audit trail per waiver.
  if (method === 'waived' && !reason) {
    return NextResponse.json({ ok: false, error: 'method=waived requires a non-empty reason' }, { status: 400 })
  }

  if (reason) {
    console.log(`[mark-paid] admin=${user.id} application=${applicationId} method=${method} amount=${amount} reason="${reason}"`)
  }

  const result = await confirmPayment({ applicationId, method, amount, providerRef, silent })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 500 })

  await syncPortalState(applicationId, db).catch((e) =>
    console.error('[mark-paid] syncPortalState failed:', (e as Error).message)
  )

  // Zanii Proof: per-admin receipt of the manual payment confirmation. Distinct
  // from the automated cth.pay.confirmed receipt (confirmPayment) — this one
  // attributes the DECISION to the human who marked it paid.
  await recordAdminAction({
    actor: { email: user.email, role: actorRole },
    action: 'mark_paid',
    applicationId,
    payload: {
      method,
      amount: result.amount ?? amount ?? null,
      providerRef: providerRef || null,
      alreadyPaid: result.alreadyPaid ?? false,
      reason: reason || null,
    },
  })

  return NextResponse.json({ ok: true, alreadyPaid: result.alreadyPaid, amount: result.amount })
}
