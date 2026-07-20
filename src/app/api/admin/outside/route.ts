// Outside-vendor roster (bedouin + truck zones — no floor-plan allocation).
//
// GET  -> every outside zone with {capacity, used, vendors:[...]} aggregated
//         from vendor_applications (filtered to outside tiers), reading the
//         ⟦ZONE:..⟧ position marker, paid status from the ⟦PORTAL:..⟧ marker,
//         and the ⟦ZONE_CHECKIN⟧ marker. (Law 8: no zones table, no phantom
//         payment columns — everything rides admin_notes.)
// POST -> assign-slot (set ⟦ZONE:key:slot⟧, 409 on a duplicate slot in the same
//         zone — same intent as the stall over-confirm guard) + check-in.
//
// Auth mirrors the sibling outside-vendor capture route (/api/admin/finance/
// capture): admin_users row required, owner/operator role gate, createAdminClient
// for the service-role reads/writes. Audited via vendor_application_events.
// Never fakes success on error.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { tierLabel } from '@/lib/stalls'
import {
  OUTSIDE_ZONES, zoneForTier, parseZoneAssignment, withZoneAssignment,
  withZoneCheckIn, isOutsideZone, type OutsideZoneKey,
} from '@/lib/zones'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireOperator() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized', status: 401 as const }
  const admin = createAdminClient()
  const { data: adminUser } = await admin
    .from('admin_users')
    .select('id, role, email')
    .eq('id', user.id)
    .single()
  if (!adminUser) return { error: 'forbidden', status: 403 as const }
  const role = (adminUser.role || 'operator') as string
  if (!['owner', 'operator'].includes(role)) {
    return { error: 'insufficient_role', status: 403 as const }
  }
  return { admin, adminUser, userEmail: user.email || null }
}

interface OutsideVendorRow {
  id: string
  business_name: string
  contact_name: string | null
  phone: string | null
  email: string | null
  tier: string | null
  tier_label: string
  zone: OutsideZoneKey
  // Application status, tagged so the UI can split committed (approved) from the
  // waiting pipeline (pending / info_requested). 'approved' = committed.
  status: string
  committed: boolean
  slot: number | null
  paid: boolean
  payment_status: string
  checkedIn: boolean
  checked_in_at: string | null
}

// Pull every outside-tier vendor once, return rows + a code->occupant map keyed
// by `${zone}:${slot}` so the slot over-confirm guard is a single lookup.
async function loadRoster(admin: ReturnType<typeof createAdminClient>) {
  const { data: apps } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, phone, email, preferred_booth_tier, status, admin_notes')

  const vendors: OutsideVendorRow[] = []
  const bySlot = new Map<string, OutsideVendorRow>() // `${zone}:${slot}` -> vendor

  for (const a of apps || []) {
    const zone = zoneForTier(a.preferred_booth_tier as string | null)
    if (!zone) continue // not an outside vendor — skip
    // Roster the live pipeline (approved / pending / info_requested), the same
    // set /admin/finance tracks. Discarded/withdrawn rows drop out.
    if (!['approved', 'pending', 'info_requested'].includes((a.status as string) || '')) continue

    const za = parseZoneAssignment(a.admin_notes as string)
    const portal = parsePortalState(a.admin_notes as string)
    const paymentStatus = (portal.payment?.status || 'none') as string
    const paid = paymentStatus === 'paid' || paymentStatus === 'waived'
    const status = (a.status as string) || ''
    const committed = status === 'approved' // fills a spot; pending/info_requested wait

    const row: OutsideVendorRow = {
      id: a.id,
      business_name: (a.business_name as string) || 'Unnamed',
      contact_name: (a.contact_name as string) || null,
      phone: (a.phone as string) || null,
      email: (a.email as string) || null,
      tier: (a.preferred_booth_tier as string) || null,
      tier_label: tierLabel(a.preferred_booth_tier as string),
      zone,
      status,
      committed,
      slot: za.slot,
      paid,
      payment_status: paymentStatus,
      checkedIn: !!za.checkedInAt,
      checked_in_at: za.checkedInAt,
    }
    vendors.push(row)
    if (za.slot != null) bySlot.set(`${zone}:${za.slot}`, row)
  }
  return { vendors, bySlot }
}

export async function GET() {
  try {
    const auth = await requireOperator()
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const { vendors } = await loadRoster(auth.admin)

    const zones = OUTSIDE_ZONES.map((z) => {
      const zoneVendors = vendors
        .filter((v) => v.zone === z.key)
        .sort((a, b) => {
          // Committed (approved) first, then the waiting pipeline. Within each
          // group, placed (with a slot) first ordered by slot, then by name.
          if (a.committed !== b.committed) return a.committed ? -1 : 1
          if (a.slot != null && b.slot != null) return a.slot - b.slot
          if (a.slot != null) return -1
          if (b.slot != null) return 1
          return a.business_name.localeCompare(b.business_name)
        })
      // committed = approved vendors that fill the spots; pending = the waiting
      // pipeline (pending / info_requested). Capacity is judged on committed only,
      // so "over" never fires on the waiting list.
      const committed = zoneVendors.filter((v) => v.committed).length
      const pending = zoneVendors.length - committed
      return {
        key: z.key,
        label: z.label,
        capacity: z.capacity,
        committed,
        pending,
        over: committed > z.capacity,
        used: zoneVendors.length,
        placed: zoneVendors.filter((v) => v.slot != null).length,
        checkedIn: zoneVendors.filter((v) => v.checkedIn).length,
        vendors: zoneVendors,
      }
    })

    return NextResponse.json({ zones })
  } catch (e) {
    console.error('[admin/outside] GET', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const assignSchema = z.object({
  action: z.literal('assign-slot'),
  applicationId: z.string().uuid(),
  zone: z.string().min(1).max(40),
  slot: z.number().int().positive().max(999).nullable(), // null clears the assignment
})
const checkinSchema = z.object({
  action: z.literal('check-in'),
  applicationId: z.string().uuid(),
  checkedIn: z.boolean(),
})
const bodySchema = z.discriminatedUnion('action', [assignSchema, checkinSchema])

export async function POST(req: NextRequest) {
  try {
    const auth = await requireOperator()
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const admin = auth.admin

    let body: z.infer<typeof bodySchema>
    try {
      body = bodySchema.parse(await req.json())
    } catch (e) {
      if (e instanceof z.ZodError) return NextResponse.json({ error: 'invalid body', details: e.issues }, { status: 400 })
      throw e
    }

    // The application must exist AND be an outside vendor (zone derived from its
    // own tier — operators don't get to reassign a marquee vendor here).
    const { data: app } = await admin
      .from('vendor_applications')
      .select('id, business_name, preferred_booth_tier, admin_notes')
      .eq('id', body.applicationId)
      .single()
    if (!app) return NextResponse.json({ error: 'application not found' }, { status: 404 })

    const vendorZone = zoneForTier(app.preferred_booth_tier as string | null)
    if (!vendorZone) {
      return NextResponse.json({ error: 'not an outside vendor' }, { status: 400 })
    }

    // ---- CHECK-IN (set/clear ⟦ZONE_CHECKIN⟧) ----
    if (body.action === 'check-in') {
      const checkedInAt = body.checkedIn ? new Date().toISOString() : null
      const newNotes = withZoneCheckIn(app.admin_notes as string, checkedInAt)
      const { error } = await admin
        .from('vendor_applications')
        .update({ admin_notes: newNotes })
        .eq('id', body.applicationId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      try {
        await admin.from('vendor_application_events').insert({
          application_id: body.applicationId,
          event_type: body.checkedIn ? 'zone_checked_in' : 'zone_checkin_cleared',
          after_value: { zone: vendorZone, checked_in_at: checkedInAt },
          actor_email: auth.adminUser.email || auth.userEmail,
          actor_role: 'operator',
        })
      } catch (e) {
        console.error('[admin/outside] checkin audit failed:', (e as Error).message)
      }

      return NextResponse.json({
        ok: true,
        applicationId: body.applicationId,
        business_name: app.business_name,
        checkedIn: body.checkedIn,
        checked_in_at: checkedInAt,
      })
    }

    // ---- ASSIGN-SLOT (set/clear ⟦ZONE:zone:slot⟧) ----
    // The requested zone must match the vendor's own tier-derived zone; we don't
    // trust the client to relocate a vendor across zones.
    if (!isOutsideZone(body.zone) || body.zone !== vendorZone) {
      return NextResponse.json(
        { error: `vendor belongs to ${vendorZone}, not ${body.zone}` },
        { status: 400 },
      )
    }

    // Capacity + duplicate-slot guard. Reload the live roster so the guard sees
    // every other vendor's current marker (over-confirm pattern, 409).
    const { bySlot } = await loadRoster(admin)

    if (body.slot != null) {
      const zoneMeta = OUTSIDE_ZONES.find((z) => z.key === body.zone)!
      if (body.slot > zoneMeta.capacity) {
        return NextResponse.json(
          { error: `${zoneMeta.label} only has ${zoneMeta.capacity} positions (you asked for #${body.slot}).`, code: 'SLOT_OUT_OF_RANGE' },
          { status: 400 },
        )
      }
      const taken = bySlot.get(`${body.zone}:${body.slot}`)
      if (taken && taken.id !== body.applicationId) {
        return NextResponse.json(
          { error: `${zoneMeta.label} #${body.slot} is already taken by ${taken.business_name}. Clear it first.`, code: 'SLOT_TAKEN' },
          { status: 409 },
        )
      }
    }

    const newNotes = withZoneAssignment(app.admin_notes as string, body.slot != null ? (body.zone as OutsideZoneKey) : null, body.slot)
    const { error } = await admin
      .from('vendor_applications')
      .update({ admin_notes: newNotes })
      .eq('id', body.applicationId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    try {
      await admin.from('vendor_application_events').insert({
        application_id: body.applicationId,
        event_type: body.slot != null ? 'zone_slot_assigned' : 'zone_slot_cleared',
        after_value: { zone: body.zone, slot: body.slot },
        actor_email: auth.adminUser.email || auth.userEmail,
        actor_role: 'operator',
      })
    } catch (e) {
      console.error('[admin/outside] assign audit failed:', (e as Error).message)
    }

    return NextResponse.json({
      ok: true,
      applicationId: body.applicationId,
      business_name: app.business_name,
      zone: body.zone,
      slot: body.slot,
    })
  } catch (e) {
    console.error('[admin/outside] POST', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
