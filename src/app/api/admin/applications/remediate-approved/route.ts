// One-off / on-demand remediation: notify vendors who were marked "approved"
// but never received the approval email + WhatsApp + portal account.
//
// WHY (2026-06-19 audit): the workbench approve path skipped all side-effects,
// so a batch of vendors sit "approved" with no notification and no login. The
// forward fix (decision-notify wired into the action/bulk routes) stops new
// cases; THIS endpoint drains the existing backlog.
//
// Idempotent: skips anyone already carrying the ⟦APPROVED_NOTIFIED⟧ marker, and
// notifyApplicationDecision stamps that marker on a successful send — so a
// re-run never double-notifies.
//
// Auth: Bearer CRON_SECRET (same gate as cron routes). Not admin-cookie gated so
// it can be driven by a scheduled curl / launchd job.
//
// Body: {
//   ids?: string[]        // explicit application ids (preferred). If omitted,
//                         // auto-selects approved rows missing the marker.
//   limit?: number        // cap when auto-selecting (default 25)
//   dryRun?: boolean      // report who WOULD be notified, send nothing
// }

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { notifyApplicationDecision, APPROVED_NOTIFIED_RE } from '@/lib/applications/decision-notify'
import { notifyOwners } from '@/lib/bot/notify'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).max(200).optional(),
  limit: z.number().int().positive().max(200).optional(),
  dryRun: z.boolean().optional(),
})

interface AppRow {
  id: string
  status: string | null
  email: string | null
  business_name: string | null
  contact_name: string | null
  preferred_booth_tier: string | null
  phone: string | null
  admin_notes: string | null
}

const SELECT = 'id, status, email, business_name, contact_name, preferred_booth_tier, phone, admin_notes'

// Don't notify demo/seed rows or obviously unsendable addresses.
function isSendable(email: string | null): boolean {
  if (!email) return false
  const e = email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false   // not a valid-looking address
  if (e.endsWith('@cthalaal.co.za')) return false           // demo/internal seed accounts
  return true
}

export async function POST(req: NextRequest) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let parsed: z.infer<typeof bodySchema>
  try {
    parsed = bodySchema.parse(await req.json().catch(() => ({})))
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: 'invalid body', details: e.issues }, { status: 400 })
    }
    throw e
  }

  const db = createAdminClient()
  const limit = parsed.limit ?? 25

  // Build the candidate set.
  let candidates: AppRow[] = []
  if (parsed.ids && parsed.ids.length) {
    const { data, error } = await db.from('vendor_applications').select(SELECT).in('id', parsed.ids)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    candidates = (data ?? []) as AppRow[]
  } else {
    const { data, error } = await db
      .from('vendor_applications')
      .select(SELECT)
      .eq('status', 'approved')
      .order('approved_at', { ascending: true })
      .limit(limit * 4) // over-fetch; we filter out already-marked below
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    candidates = (data ?? []) as AppRow[]
  }

  // Decide who actually gets notified.
  const plan = candidates.map((a) => {
    let skip: string | null = null
    if (a.status !== 'approved') skip = `status=${a.status}`
    else if (APPROVED_NOTIFIED_RE.test(a.admin_notes || '')) skip = 'already_notified'
    else if (!isSendable(a.email)) skip = 'unsendable_email'
    return { app: a, skip }
  })

  const toSend = plan.filter((p) => !p.skip).slice(0, limit)
  const skipped = plan.filter((p) => p.skip)

  if (parsed.dryRun) {
    return NextResponse.json({
      dryRun: true,
      wouldSend: toSend.map((p) => ({ id: p.app.id, business: p.app.business_name, email: p.app.email })),
      skipped: skipped.map((p) => ({ id: p.app.id, business: p.app.business_name, email: p.app.email, reason: p.skip })),
      counts: { wouldSend: toSend.length, skipped: skipped.length, candidates: candidates.length },
    })
  }

  const results: Array<{
    id: string
    business: string | null
    email: string | null
    emailSent?: boolean
    emailError?: string
    waSent?: boolean
    waSkipped?: string
  }> = []

  // Sequential on purpose: stays gentle on Resend + Meta rate limits and keeps
  // the run observable in order.
  for (const { app } of toSend) {
    const r = await notifyApplicationDecision({
      admin: db,
      id: app.id,
      status: 'approved',
      app: {
        email: app.email || '',
        business_name: app.business_name || '',
        contact_name: app.contact_name || '',
        preferred_booth_tier: app.preferred_booth_tier,
        phone: app.phone,
        admin_notes: app.admin_notes,
      },
    })
    results.push({
      id: app.id,
      business: app.business_name,
      email: app.email,
      emailSent: r.emailSent,
      emailError: r.emailError,
      waSent: r.waSent,
      waSkipped: r.waSkipped,
    })
  }

  const emailOk = results.filter((r) => r.emailSent).length

  // One digest to the owners (Taona + Samreen) for the whole batch — not one
  // ping per vendor (that would spam). Best-effort.
  if (emailOk > 0) {
    const names = results.filter((r) => r.emailSent).map((r) => (r.business || '').trim()).filter(Boolean)
    await notifyOwners({
      event: 'application_approved',
      body: `${emailOk} vendor${emailOk === 1 ? '' : 's'} approved + notified (email + WhatsApp): ${names.join(', ')}.`,
      // CARVE-OUT: no vendorId. Batch digest spanning many vendors. This body
      // does list vendor NAMES, some of whom may be on the EFT lane; the
      // operator confirmed 2026-07-25 that approvals are the owner's job and
      // names alone (no payment status, no amounts) are acceptable to her.
    }).catch((e) => console.error('[remediate] notifyOwners failed:', (e as Error).message))
  }

  return NextResponse.json({
    dryRun: false,
    counts: {
      attempted: results.length,
      emailSent: emailOk,
      emailFailed: results.length - emailOk,
      skipped: skipped.length,
    },
    results,
    skipped: skipped.map((p) => ({ id: p.app.id, email: p.app.email, reason: p.skip })),
  })
}
