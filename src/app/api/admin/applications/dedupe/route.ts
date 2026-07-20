// Dedupe endpoint: pick a keeper, supersede the rest.
// Triggered from the workbench dedupe drawer. The drawer surfaces
// phone-grouped clusters and asks Samreen to nominate the "real" row;
// everyone else in the cluster gets is_duplicate=true,
// duplicate_of_id=<keeper>, superseded_at=now().
//
// Each superseded row gets its own vendor_application_events 'superseded'
// row so we can reverse the decision later (and so the audit trail names
// who did it).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'
import { capJsonbSize } from '@/lib/audit/cap'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  keeper_id: z.string().uuid(),
  superseded_ids: z.array(z.string().uuid()).min(1).max(50),
})

export async function POST(request: NextRequest) {
  try {
    const gate = await requireOperator()
    if (!gate.ok) return gate.response
    const { adminUser } = gate

    const admin = createAdminClient()
    const actorEmail = adminUser.email

    const body = await request.json()
    const parsed = bodySchema.parse(body)
    const { keeper_id, superseded_ids } = parsed

    if (superseded_ids.includes(keeper_id)) {
      return NextResponse.json(
        { error: 'keeper_id cannot also be in superseded_ids' },
        { status: 400 }
      )
    }

    // Confirm keeper exists before we touch the others.
    const { data: keeper, error: keeperErr } = await admin
      .from('vendor_applications')
      .select('id, business_name')
      .eq('id', keeper_id)
      .single()
    if (keeperErr || !keeper) {
      return NextResponse.json({ error: 'Keeper application not found' }, { status: 404 })
    }

    // Snapshot before so each audit row has a meaningful before_value.
    const { data: beforeRows, error: loadErr } = await admin
      .from('vendor_applications')
      .select('id, is_duplicate, duplicate_of_id, superseded_at')
      .in('id', superseded_ids)
    if (loadErr) {
      return NextResponse.json({ error: 'Failed to load applications' }, { status: 500 })
    }
    const beforeById = new Map((beforeRows ?? []).map((r) => [r.id as string, r]))

    const nowIso = new Date().toISOString()

    // We update one row at a time so we know exactly which rows succeeded
    // and which failed — a single .in().update() would mask per-row errors.
    const results: Array<{ id: string; ok: boolean; error?: string }> = []
    const events: Array<{
      application_id: string
      event_type: 'superseded'
      before_value: Record<string, unknown>
      after_value: Record<string, unknown>
      actor_email: string | null
      actor_role: string
      note: string
    }> = []

    for (const id of superseded_ids) {
      const before = beforeById.get(id)
      if (!before) {
        results.push({ id, ok: false, error: 'not found' })
        continue
      }
      const { error: updErr } = await admin
        .from('vendor_applications')
        .update({
          is_duplicate: true,
          duplicate_of_id: keeper_id,
          superseded_at: nowIso,
        })
        .eq('id', id)
      if (updErr) {
        results.push({ id, ok: false, error: updErr.message })
        continue
      }
      events.push({
        application_id: id,
        event_type: 'superseded',
        before_value: capJsonbSize({
          is_duplicate: before.is_duplicate ?? false,
          duplicate_of_id: before.duplicate_of_id ?? null,
          superseded_at: before.superseded_at ?? null,
        }) as Record<string, unknown>,
        after_value: capJsonbSize({
          is_duplicate: true,
          duplicate_of_id: keeper_id,
          superseded_at: nowIso,
        }) as Record<string, unknown>,
        actor_email: actorEmail,
        actor_role: 'operator',
        note: `keeper=${keeper_id}`,
      })
      results.push({ id, ok: true })
    }

    if (events.length > 0) {
      const { error: evErr } = await admin.from('vendor_application_events').insert(events)
      if (evErr) console.error('[dedupe] vendor_application_events insert failed:', evErr.message)
    }

    const okCount = results.filter((r) => r.ok).length
    return NextResponse.json({
      success: true,
      keeper_id,
      processed: results.length,
      ok: okCount,
      failed: results.length - okCount,
      results,
    })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    console.error('[dedupe] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
