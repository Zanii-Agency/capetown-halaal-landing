import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'
import { capJsonbSize } from '@/lib/audit/cap'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  keeper_id: z.string().uuid(),
  duplicate_id: z.string().uuid(),
  fields: z.record(z.string(), z.enum(['keeper', 'duplicate'])).optional(),
})

// Fields eligible for merge (non-relational, scalar only)
const MERGEABLE_FIELDS = [
  'business_name',
  'contact_name',
  'email',
  'phone',
  'business_description',
  'website',
  'instagram',
  'facebook',
  'preferred_booth_tier',
  'special_requirements',
  'product_categories',
  'sector',
  'admin_notes',
  'payment_status',
  'payment_amount',
  'payment_due_date',
  'completeness_score',
] as const

export async function POST(request: NextRequest) {
  try {
    const gate = await requireOperator()
    if (!gate.ok) return gate.response
    const { adminUser, role } = gate

    const admin = createAdminClient()
    const actorEmail = adminUser.email

    const body = await request.json()
    const parsed = bodySchema.parse(body)
    const { keeper_id, duplicate_id, fields: fieldOverrides } = parsed

    if (keeper_id === duplicate_id) {
      return NextResponse.json({ error: 'keeper and duplicate must be different' }, { status: 400 })
    }

    // Load both rows
    const { data: rows, error: loadErr } = await admin
      .from('vendor_applications')
      .select('*')
      .in('id', [keeper_id, duplicate_id])
    if (loadErr || !rows || rows.length !== 2) {
      return NextResponse.json({ error: 'One or both applications not found' }, { status: 404 })
    }

    const keeper = rows.find((r) => r.id === keeper_id) as Record<string, unknown>
    const duplicate = rows.find((r) => r.id === duplicate_id) as Record<string, unknown>
    if (!keeper || !duplicate) {
      return NextResponse.json({ error: 'Unexpected row mapping' }, { status: 500 })
    }

    // Build the update patch for keeper. By default, copy non-null fields from
    // duplicate that are null on keeper. If fieldOverrides is provided, respect it.
    const patch: Record<string, unknown> = {}
    const fieldLog: string[] = []

    if (fieldOverrides) {
      for (const [field, source] of Object.entries(fieldOverrides)) {
        if (!MERGEABLE_FIELDS.includes(field as never)) continue
        if (source === 'duplicate' && duplicate[field] !== undefined) {
          patch[field] = duplicate[field]
          fieldLog.push(`${field}=from_duplicate`)
        } else if (source === 'keeper' && keeper[field] !== undefined) {
          // Keep existing — no change needed
          fieldLog.push(`${field}=keep_keeper`)
        }
      }
    } else {
      // Default: merge non-null fields from duplicate that are null on keeper
      for (const field of MERGEABLE_FIELDS) {
        if (
          (keeper[field] === null || keeper[field] === undefined) &&
          duplicate[field] !== null &&
          duplicate[field] !== undefined
        ) {
          patch[field] = duplicate[field]
          fieldLog.push(`${field}=from_duplicate`)
        }
      }
    }

    if (Object.keys(patch).length > 0) {
      const { error: updErr } = await admin
        .from('vendor_applications')
        .update(patch)
        .eq('id', keeper_id)
      if (updErr) {
        console.error('[merge] keeper update failed:', updErr.message)
        return NextResponse.json({ error: 'Failed to update keeper' }, { status: 500 })
      }
    }

    // Mark duplicate as superseded
    const nowIso = new Date().toISOString()
    const { error: dupErr } = await admin
      .from('vendor_applications')
      .update({
        is_duplicate: true,
        duplicate_of_id: keeper_id,
        superseded_at: nowIso,
      })
      .eq('id', duplicate_id)
    if (dupErr) {
      console.error('[merge] duplicate mark failed:', dupErr.message)
      return NextResponse.json({ error: 'Failed to mark duplicate' }, { status: 500 })
    }

    // Audit log
    const { error: evErr } = await admin.from('vendor_application_events').insert([
      {
        application_id: keeper_id,
        event_type: 'merged_into',
        before_value: capJsonbSize({}) as Record<string, unknown>,
        after_value: capJsonbSize({ merged_fields: fieldLog }) as Record<string, unknown>,
        actor_email: actorEmail,
        actor_role: role,
        note: `Merged fields from ${duplicate_id}: ${fieldLog.join(', ') || 'none'}`,
      },
      {
        application_id: duplicate_id,
        event_type: 'superseded',
        before_value: capJsonbSize({
          is_duplicate: false,
          duplicate_of_id: null,
          superseded_at: null,
        }) as Record<string, unknown>,
        after_value: capJsonbSize({
          is_duplicate: true,
          duplicate_of_id: keeper_id,
          superseded_at: nowIso,
        }) as Record<string, unknown>,
        actor_email: actorEmail,
        actor_role: role,
        note: `Merged into keeper ${keeper_id}`,
      },
    ])
    if (evErr) console.error('[merge] audit insert failed:', evErr.message)

    return NextResponse.json({
      success: true,
      keeper_id,
      duplicate_id,
      merged_fields: fieldLog,
    })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    console.error('[merge] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
