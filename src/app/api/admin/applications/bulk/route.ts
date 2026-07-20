// Bulk triage action endpoint for the workbench.
// Same actions as /api/admin/applications/[id]/action, but applied across
// N selected rows. Each row gets its own vendor_application_events audit row
// so the trail stays per-application.
//
// NOTE: this is the *admin* bulk endpoint. There is a pre-existing
// /api/applications/bulk route that handles the legacy "send_template" path
// + WhatsApp template firing — we keep that one untouched. This endpoint
// is the lean, audit-first one wired into the keyboard workbench.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'
import { capJsonbSize } from '@/lib/audit/cap'
import {
  notifyApplicationDecision,
  APPROVED_NOTIFIED_RE,
} from '@/lib/applications/decision-notify'
import { notifyOwners } from '@/lib/bot/notify'
import { z } from 'zod'

// Cap synchronous vendor-facing sends per bulk call. Keeps us under the Resend
// daily cap and the Vercel function timeout. Rows beyond the cap are reported
// as notified:false reason:'deferred' (NOT silently dropped) so the operator
// knows to drain them via the remediation endpoint.
const BULK_NOTIFY_CAP = 40

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ACTIONS = ['approve', 'reject', 'request_info', 'tag'] as const
type Action = (typeof ACTIONS)[number]

const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(ACTIONS),
  reason: z.string().max(2000).optional(),
  sector: z.string().max(64).optional(),
})

// H2: per-admin bulk rate limit. 10 bulk actions per minute, in-memory map.
const bulkRateBuckets = new Map<string, { count: number; resetAt: number }>()
const BULK_RATE_WINDOW_MS = 60_000
const BULK_RATE_MAX = 10
function checkBulkRate(actorKey: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now()
  const bucket = bulkRateBuckets.get(actorKey)
  if (!bucket || bucket.resetAt <= now) {
    bulkRateBuckets.set(actorKey, { count: 1, resetAt: now + BULK_RATE_WINDOW_MS })
    if (bulkRateBuckets.size > 500) {
      for (const [k, v] of bulkRateBuckets) if (v.resetAt <= now) bulkRateBuckets.delete(k)
    }
    return { ok: true }
  }
  if (bucket.count >= BULK_RATE_MAX) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) }
  }
  bucket.count++
  return { ok: true }
}

interface Result {
  id: string
  ok: boolean
  error?: string
  notified?: boolean
  notifyError?: string
  waSkipped?: string
  /** true when the row was approved/rejected but its send was deferred past the
   *  per-call cap — drain via the remediation endpoint. */
  deferred?: boolean
}

export async function POST(request: NextRequest) {
  try {
    const gate = await requireOperator()
    if (!gate.ok) return gate.response
    const { user, adminUser } = gate

    const admin = createAdminClient()
    const actorEmail = adminUser.email

    // H2: per-admin bulk rate limit (10/min).
    const rate = checkBulkRate(`bulk:${user.id}`)
    if (!rate.ok) {
      return NextResponse.json(
        { error: 'rate_limited', retry_after_seconds: rate.retryAfter },
        { status: 429, headers: { 'retry-after': String(rate.retryAfter) } },
      )
    }

    const body = await request.json()
    const parsed = bulkSchema.parse(body)
    const { ids, action } = parsed

    if (action === 'tag' && !(parsed.sector || '').trim()) {
      return NextResponse.json({ error: 'sector required for action=tag' }, { status: 400 })
    }

    // Snapshot existing rows once. We need before-values for the audit log
    // and we want to skip rows that don't exist rather than hit the network
    // N times.
    const { data: rows, error: loadErr } = await admin
      .from('vendor_applications')
      .select('id, status, sector, reviewed_at, approved_at, admin_notes, email, business_name, contact_name, preferred_booth_tier, phone')
      .in('id', ids)
    if (loadErr) {
      return NextResponse.json({ error: 'Failed to load applications' }, { status: 500 })
    }
    const rowsById = new Map((rows ?? []).map((r) => [r.id as string, r]))

    const nowIso = new Date().toISOString()
    const results: Result[] = []
    let notifiedCount = 0
    const events: Array<{
      application_id: string
      event_type: string
      before_value: Record<string, unknown> | null
      after_value: Record<string, unknown> | null
      actor_email: string | null
      actor_role: string
      note: string | null
    }> = []

    for (const id of ids) {
      const before = rowsById.get(id)
      if (!before) {
        results.push({ id, ok: false, error: 'not found' })
        continue
      }

      const update: Record<string, unknown> = {}
      let eventType: string
      let note: string | null = null

      switch (action) {
        case 'approve':
          update.status = 'approved'
          update.approved_at = nowIso
          if (!before.reviewed_at) update.reviewed_at = nowIso
          eventType = 'approved'
          break
        case 'reject':
          update.status = 'rejected'
          update.reviewed_at = nowIso
          eventType = 'rejected'
          note = parsed.reason || null
          break
        case 'request_info':
          update.status = 'info_requested'
          update.reviewed_at = nowIso
          eventType = 'info_requested'
          note = parsed.reason || null
          break
        case 'tag':
          update.sector = (parsed.sector as string).trim()
          eventType = 'tagged'
          break
        default:
          results.push({ id, ok: false, error: 'unknown action' })
          continue
      }

      const { data: after, error: updErr } = await admin
        .from('vendor_applications')
        .update(update)
        .eq('id', id)
        .select('id, status, sector, reviewed_at, approved_at, admin_notes')
        .single()
      if (updErr || !after) {
        results.push({ id, ok: false, error: updErr?.message || 'update failed' })
        continue
      }

      const beforeSubset: Record<string, unknown> = {}
      const afterSubset: Record<string, unknown> = {}
      for (const k of Object.keys(update)) {
        beforeSubset[k] = (before as unknown as Record<string, unknown>)[k] ?? null
        afterSubset[k] = (after as unknown as Record<string, unknown>)[k] ?? null
      }
      events.push({
        application_id: id,
        event_type: eventType,
        before_value: capJsonbSize(beforeSubset),
        after_value: capJsonbSize(afterSubset),
        actor_email: actorEmail,
        actor_role: 'operator',
        note,
      })

      // Vendor-facing side-effects on a real transition (same fix as the
      // single-action route). Capped per call; overflow is reported, not dropped.
      const b = before as unknown as {
        status: string | null
        admin_notes?: string | null
        email?: string | null
        business_name?: string | null
        contact_name?: string | null
        preferred_booth_tier?: string | null
        phone?: string | null
      }
      const decisionStatus =
        action === 'approve' ? 'approved' as const :
        action === 'reject' ? 'rejected' as const :
        action === 'request_info' ? 'info_requested' as const : null
      const alreadyNotified =
        decisionStatus === 'approved' && APPROVED_NOTIFIED_RE.test(b.admin_notes || '')

      if (decisionStatus && b.status !== decisionStatus && !alreadyNotified) {
        if (notifiedCount >= BULK_NOTIFY_CAP) {
          results.push({ id, ok: true, notified: false, deferred: true })
        } else {
          notifiedCount++
          const r = await notifyApplicationDecision({
            admin,
            id,
            status: decisionStatus,
            app: {
              email: b.email || '',
              business_name: b.business_name || '',
              contact_name: b.contact_name || '',
              preferred_booth_tier: b.preferred_booth_tier,
              phone: b.phone,
              admin_notes: b.admin_notes,
            },
          })
          results.push({ id, ok: true, notified: r.emailSent, notifyError: r.emailError, waSkipped: r.waSkipped })
        }
      } else {
        results.push({ id, ok: true, notified: false })
      }
    }

    // Batch-insert events. Audit insert failure should not flip a successful
    // mutation — but it MUST be logged so we know we have an audit gap.
    if (events.length > 0) {
      const { error: evErr } = await admin.from('vendor_application_events').insert(events)
      if (evErr) console.error('[bulk] vendor_application_events insert failed:', evErr.message)
    }

    const okCount = results.filter((r) => r.ok).length

    // One owner digest for the batch (Taona + Samreen) instead of per-vendor.
    const notifiedNow = results.filter((r) => r.notified).length
    if (notifiedNow > 0) {
      const deferred = results.filter((r) => r.deferred).length
      await notifyOwners({
        event: 'application_approved',
        body: `Bulk ${action.replace('_', ' ')}: ${notifiedNow} vendor${notifiedNow === 1 ? '' : 's'} notified by email + WhatsApp${deferred ? ` (${deferred} deferred — run remediation)` : ''}.`,
      }).catch((e) => console.error('[bulk] notifyOwners failed:', (e as Error).message))
    }

    return NextResponse.json({
      success: true,
      action,
      processed: results.length,
      ok: okCount,
      failed: results.length - okCount,
      results,
    })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    console.error('[bulk] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
