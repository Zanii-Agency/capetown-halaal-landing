import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'
import {
  STALL_LIST, STALL_GRID, STALL_ZONES, STALL_CAPACITY, TYPE_META,
  parseAllocation, withAllocation, removeStallCode, tierLabel, stallTypeOf,
  type StallType, type StallStatus,
} from '@/lib/stalls'
import { parsePortalState, syncPortalState } from '@/lib/portal-state'
import { notifyVendor } from '@/lib/notifications'
import { computeVendorPricing } from '@/lib/payments/pricing'

// Festival-wide "blocked booth" set. A blocked booth has NO vendor, so it can't
// live as a ⟦STALL⟧ marker on a vendor_applications row. Following the
// announcements pattern (Law 8: DDL blocked, no stalls table), the blocked-code
// set lives as a JSON array in the private vendor-docs bucket, read/written via
// the service role. Reserved/allocated/held still ride the per-vendor marker.
const BLOCKED_BUCKET = 'vendor-docs'
const BLOCKED_PATH = '_system/blocked-stalls.json'

async function loadBlocked(admin: ReturnType<typeof createAdminClient>): Promise<Set<string>> {
  const { data, error } = await admin.storage.from(BLOCKED_BUCKET).download(BLOCKED_PATH)
  if (error || !data) return new Set()
  try {
    const arr = JSON.parse(await data.text()) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

async function saveBlocked(admin: ReturnType<typeof createAdminClient>, codes: Set<string>) {
  // Check { error }: a failed write here would otherwise report success and the
  // operator would be told the stall was blocked when nothing persisted. Surface
  // it so the POST handler's try/catch returns a real error instead of ok:true.
  const { error } = await admin.storage.from(BLOCKED_BUCKET).upload(
    BLOCKED_PATH,
    Buffer.from(JSON.stringify([...codes])),
    { contentType: 'application/json', upsert: true },
  )
  if (error) {
    console.error('[stalls] saveBlocked upload failed:', error.message)
    throw new Error(`Failed to save blocked stalls: ${error.message}`)
  }
}

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized', status: 401 as const }
  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id,email').eq('id', user.id).single()
  if (!adminUser) return { error: 'Forbidden', status: 403 as const }
  return { admin, adminUser }
}

// Pull every application's allocation marker once, return a code -> occupant map.
async function loadOccupants(admin: ReturnType<typeof createAdminClient>) {
  const { data: apps } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, phone, email, product_categories, preferred_booth_tier, status, admin_notes, special_requirements')

  const byCode = new Map<string, Record<string, unknown>>()
  const allocatable: Record<string, unknown>[] = []

  for (const a of apps || []) {
    // parseAllocation is cheap (regex on admin_notes). The expensive work,
    // computeVendorPricing + parsePortalState, only matters for rows we keep:
    // approved applicants or anyone already placed on a stall. Skip the rest so
    // discarded rows cost nothing.
    const { stall, stalls, status } = parseAllocation(a.admin_notes as string)
    if (a.status !== 'approved' && stalls.length === 0) continue

    const portal = parsePortalState(a.admin_notes as string)
    const pricing = computeVendorPricing({
      preferred_booth_tier: a.preferred_booth_tier as string,
      special_requirements: a.special_requirements,
    })
    const paymentStatus = (portal.payment?.status || 'none') as string
    const paymentAmount =
      portal.payment?.amount && portal.payment.amount > 0 ? portal.payment.amount : pricing.total
    const row = {
      id: a.id,
      business_name: a.business_name,
      contact_name: a.contact_name,
      phone: a.phone,
      email: a.email,
      categories: a.product_categories || [],
      tier: a.preferred_booth_tier,
      tier_label: tierLabel(a.preferred_booth_tier as string),
      app_status: a.status,
      stall,                                   // first code (backward-compat)
      stalls,                                  // full list (multi-booth)
      booth_count: stalls.length,
      stall_status: stalls.length ? status : null,
      payment_status: paymentStatus,
      payment_amount: paymentAmount,
      payment_ref: portal.payment?.provider_ref || portal.payment?.reference || null,
    }
    // Reverse map: EVERY code the vendor holds points back to this row, so the
    // floor highlights all of a multi-booth vendor's stalls (not just the first).
    for (const code of stalls) byCode.set(code, row)
    // dropdown = approved applicants + anyone already placed (so you can add/move them)
    allocatable.push(row)
  }
  return { byCode, allocatable }
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { byCode, allocatable } = await loadOccupants(auth.admin)
    const blocked = await loadBlocked(auth.admin)

    const stalls = STALL_LIST.map((s) => {
      const occ = byCode.get(s.code)
      // A vendor marker wins over a blocked flag (an occupied stall can't be
      // "blocked"). Otherwise a blocked code reads as blocked, else available.
      const status: StallStatus = occ
        ? (occ.stall_status as StallStatus)
        : blocked.has(s.code) ? 'blocked' : 'available'
      return { ...s, status, occupant: occ || null }
    })

    const availability: Record<StallType, { total: number; allocated: number; held: number; available: number }> =
      { FT: { total: 0, allocated: 0, held: 0, available: 0 }, FS: { total: 0, allocated: 0, held: 0, available: 0 }, TS: { total: 0, allocated: 0, held: 0, available: 0 }, BS: { total: 0, allocated: 0, held: 0, available: 0 } }
    for (const t of Object.keys(STALL_CAPACITY) as StallType[]) availability[t].total = STALL_CAPACITY[t]
    for (const s of stalls) {
      // reserved counts alongside allocated as committed; held + blocked are
      // off-market (neither available nor a firm allocation).
      if (s.status === 'allocated' || s.status === 'reserved') availability[s.type].allocated++
      else if (s.status === 'held' || s.status === 'blocked') availability[s.type].held++
    }
    for (const t of Object.keys(availability) as StallType[]) {
      availability[t].available = availability[t].total - availability[t].allocated - availability[t].held
    }

    allocatable.sort((a, b) => String(a.business_name).localeCompare(String(b.business_name)))

    return NextResponse.json({
      stalls, availability, applications: allocatable,
      grid: STALL_GRID, zones: STALL_ZONES, types: TYPE_META,
    })
  } catch (e) {
    console.error('stalls GET', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    // Mutating: allocates/holds/blocks/clears stalls + fires vendor notifications.
    // Centralised owner/operator gate (the local requireAdmin above stays on GET).
    const gate = await requireOperator()
    if (!gate.ok) return gate.response
    const admin = createAdminClient()

    const body = await req.json().catch(() => ({}))
    const stallCode: string = body.stall_code
    const applicationId: string | null = body.application_id ?? null
    const action: 'allocated' | 'held' | 'reserved' | 'blocked' | 'clear' = body.status || 'allocated'

    if (!stallCode || !stallTypeOf(stallCode)) {
      return NextResponse.json({ error: `Unknown stall ${stallCode}` }, { status: 400 })
    }

    const { byCode } = await loadOccupants(admin)
    const blocked = await loadBlocked(admin)
    const current = byCode.get(stallCode) as { id: string; business_name?: string } | undefined

    // ---- BLOCK a stall (festival-wide, no vendor) ----
    if (action === 'blocked') {
      // Can't block a stall a vendor already holds — same intent as the
      // over-confirm guard: clear the vendor first.
      if (current) {
        return NextResponse.json({
          error: `${stallCode} is taken by ${current.business_name || 'a vendor'}. Clear it before blocking.`,
          code: 'STALL_TAKEN',
        }, { status: 409 })
      }
      if (!blocked.has(stallCode)) {
        blocked.add(stallCode)
        await saveBlocked(admin, blocked)
      }
      return NextResponse.json({ ok: true, message: `${stallCode} blocked` })
    }

    // ---- CLEAR a stall (also un-blocks) ----
    if (action === 'clear' || !applicationId) {
      let cleared = false
      if (blocked.has(stallCode)) {
        blocked.delete(stallCode)
        await saveBlocked(admin, blocked)
        cleared = true
      }
      if (current) {
        // Release ONLY this code from the vendor's list. removeStallCode keeps
        // their other booths and drops the marker only when this was their last.
        const { data: app } = await admin.from('vendor_applications').select('admin_notes').eq('id', current.id).single()
        const { error } = await admin.from('vendor_applications').update({ admin_notes: removeStallCode(app?.admin_notes, stallCode) }).eq('id', current.id)
        if (error) {
          console.error('[stalls clear] update failed:', error.message)
          return NextResponse.json({ error: error.message }, { status: 500 })
        }
        cleared = true
      }
      return NextResponse.json({ ok: true, message: cleared ? `${stallCode} cleared` : `${stallCode} already free` })
    }

    // ---- OVER-CONFIRM GUARD: stall already taken by a different vendor ----
    if (current && current.id !== applicationId) {
      return NextResponse.json({
        error: `${stallCode} is already taken by ${current.business_name || 'another vendor'}. Clear it first.`,
        code: 'STALL_TAKEN',
      }, { status: 409 })
    }

    // ---- GUARD: a blocked stall is off-market until explicitly cleared ----
    if (blocked.has(stallCode)) {
      return NextResponse.json({
        error: `${stallCode} is blocked. Unblock it before allocating.`,
        code: 'STALL_BLOCKED',
      }, { status: 409 })
    }

    // application must exist
    const { data: app } = await admin
      .from('vendor_applications')
      .select('id, business_name, admin_notes, status')
      .eq('id', applicationId).single()
    if (!app) return NextResponse.json({ error: 'Application not found' }, { status: 404 })

    // Multi-booth: withAllocation APPENDS this code to the vendor's existing list
    // (does not move/replace their other booths). The over-confirm guard above
    // already ensured no OTHER vendor holds this code. Status is per-vendor: the
    // action applies to the whole marker (confirming/reserving the vendor's set).
    const newNotes = withAllocation(app.admin_notes, stallCode, action)
    const { error } = await admin.from('vendor_applications').update({ admin_notes: newNotes }).eq('id', applicationId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Best-effort: fire the vendor_stall_allocation WhatsApp template ONLY on
    // a fresh allocation (not on hold). Vendor learns their stall + zone.
    if (action === 'allocated') {
      try {
        const { data: full } = await admin
          .from('vendor_applications')
          .select('phone, contact_name')
          .eq('id', applicationId).single()
        const phone = full?.phone as string | undefined
        if (phone && full) {
          const stallMeta = STALL_LIST.find((s) => s.code === stallCode)
          const zone = STALL_ZONES.find((z) =>
            stallMeta && stallMeta.col >= z.col && stallMeta.col < z.col + z.w
            && stallMeta.row >= z.row && stallMeta.row < z.row + z.h
          )?.label || 'Main marquee'
          const firstName = (full.contact_name as string || '').trim().split(/\s+/)[0] || 'there'
          const { sendTemplate, toE164 } = await import('@/lib/whatsapp')
          await sendTemplate(toE164(phone), 'vendor_stall_allocation', [firstName, stallCode, zone], { category: 'utility' })
        }
      } catch (e) {
        console.error('[stalls] vendor_stall_allocation WA failed:', (e as Error).message)
      }
    }

    if (action === 'allocated') {
      await syncPortalState(applicationId, admin).catch((e) =>
        console.error('[stalls] syncPortalState failed:', (e as Error).message)
      )
      await notifyVendor({
        event: 'stall_allocated',
        applicationId,
        data: { stall: stallCode },
      }).catch((e) =>
        console.error('[stalls] notifyVendor failed:', (e as Error).message)
      )
    }

    return NextResponse.json({ ok: true, message: `${stallCode} → ${app.business_name} (${action})` })
  } catch (e) {
    console.error('stalls POST', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
