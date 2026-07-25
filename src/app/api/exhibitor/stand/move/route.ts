import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState, updatePortalState, type PortalState } from '@/lib/portal-state'
import { parseAllocation, TYPE_META, type StallType } from '@/lib/stalls'

// Vendor-side stall POSITION change request. Distinct from /stand/change (which
// changes the booth SIZE/tier). Available to any authenticated vendor, including
// before allocation — a vendor can ask for a spot before one is assigned.

export async function GET() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const app = ctx.application as Record<string, unknown>
  const state = parsePortalState((app.admin_notes as string) || null)
  return NextResponse.json({ moveRequest: state.stallMoveRequest || null })
}

export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const app = ctx.application as Record<string, unknown>
  const body = await req.json().catch(() => ({}))
  const details = String(body.details || '').trim().slice(0, 1000)
  const preferredZone = body.preferredZone ? String(body.preferredZone) : undefined

  if (!details) {
    return NextResponse.json({ error: 'Tell us what stall change you need' }, { status: 400 })
  }
  if (preferredZone && !TYPE_META[preferredZone as StallType]) {
    return NextResponse.json({ error: 'Invalid preferred area' }, { status: 400 })
  }

  const id = String(app.id)
  const currentStall = parseAllocation((app.admin_notes as string) || '').stall || undefined
  // zanii-codef: pre-allocation position requests allowed — vendor states a
  // preference before the organisers place them; currentStall may be undefined.
  const admin = createAdminClient()

  const moveRequest = {
    ...(preferredZone ? { preferredZone } : {}),
    details,
    currentStall,
    status: 'pending' as const,
    createdAt: new Date().toISOString(),
  }

  await updatePortalState(id, (s: PortalState) => ({ ...s, stallMoveRequest: moveRequest }))

  try {
    await admin.from('vendor_application_events').insert({
      application_id: id,
      event_type: 'stall_move_requested',
      note: `Vendor requested a move from ${currentStall}: ${details}`,
      actor_email: ctx.email,
    })
  } catch { /* table may not exist */ }

  // Best-effort operator ping so the request does not vanish into the marker.
  try {
    const bizName = (app.business_name as string) || 'A vendor'
    const zoneLabel = preferredZone ? TYPE_META[preferredZone as StallType].label : 'no area preference'
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({
      event: 'system_alert',
      body: `Stall position change requested by ${bizName} (currently ${currentStall}, prefers ${zoneLabel}). Details: ${details}\n\nReview at /admin/stall-changes`,
      audience: 'all',
      vendorId: app.id as string, // EFT-lane vendors' self-service stays on master
    })
  } catch (e) {
    console.error('[exhibitor/stand/move] notifyOwners failed:', (e as Error).message)
  }

  return NextResponse.json({ moveRequest })
}
