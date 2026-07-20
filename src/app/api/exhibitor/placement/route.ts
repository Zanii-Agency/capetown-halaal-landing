import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getExhibitorContext } from '@/lib/exhibitor'
import {
  STALL_LIST, STALL_GRID, STALL_ZONES, TYPE_META,
  parseAllocation, tierLabel, type StallType,
} from '@/lib/stalls'

// CTH-DOCTRINE Law 2 (vendor-data-privacy).
//
// This endpoint was previously unauthenticated and accepted an email in the
// POST body. Anyone could enumerate which emails had vendor applications, AND
// receive the matched vendor's stall_code + the business_name of 8 nearest
// neighbour vendors. That was a direct Law 2 leak.
//
// New rules:
//   - Caller MUST be a signed-in exhibitor (getExhibitorContext).
//   - The vendor identity is the SESSION vendor — no body-supplied email.
//   - The owner sees their own business_name + stall code.
//   - Non-owner neighbour stalls carry only the SECTOR LABEL ("Fashion & Style"),
//     never another vendor's business_name. The full floor grid carries zone
//     metadata only — no per-stall occupant names.
export async function POST() {
  try {
    const ctx = await getExhibitorContext()
    if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    type AppRow = {
      id: string
      business_name: string
      email: string
      product_categories: string[] | null
      preferred_booth_tier: string | null
      status: string
      admin_notes: string | null
    }
    const app = ctx.application as unknown as AppRow

    const admin = createAdminClient()
    const { data: apps } = await admin
      .from('vendor_applications')
      .select('id, business_name, admin_notes')

    // codeToOwner maps stall code → owning application id (to gate name reveal).
    const codeToOwner = new Map<string, string>()
    for (const a of (apps || []) as Array<{ id: string; business_name: string; admin_notes: string | null }>) {
      const { stalls } = parseAllocation(a.admin_notes)
      for (const stall of stalls) codeToOwner.set(stall, a.id)
    }

    const myAlloc = parseAllocation(app.admin_notes)
    const me = {
      business_name: app.business_name,
      stall: myAlloc.stall,             // first code (primary "you are here")
      stalls: myAlloc.stalls,           // full list (all my booths)
      stall_status: myAlloc.status,
      tier: app.preferred_booth_tier,
      status: app.status,
      categories: app.product_categories || [],
    }

    const myStall = me.stall ? STALL_LIST.find((s) => s.code === me.stall) : null

    // Neighbours: 8 closest allocated stalls, but business_name is REPLACED
    // with the sector/zone label. Owner identity stays private.
    let neighbours: { code: string; type: StallType; business_name: string; zone: string }[] = []
    if (myStall) {
      const cx = myStall.col + myStall.w / 2
      const cy = myStall.row + myStall.h / 2
      neighbours = STALL_LIST
        .filter((s) => s.code !== myStall.code && codeToOwner.has(s.code))
        .map((s) => ({ s, d: Math.hypot(s.col + s.w / 2 - cx, s.row + s.h / 2 - cy) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 8)
        .map(({ s }) => ({
          code: s.code,
          type: s.type,
          business_name: TYPE_META[s.type].label, // Law 2: sector label only, never another vendor's name
          zone: TYPE_META[s.type].label,
        }))
    }

    // Public grid: no per-stall occupant names — only allocation status + type.
    // Only the owner's own stall reveals a business_name.
    const stalls = STALL_LIST.map((s) => ({
      code: s.code, type: s.type, num: s.num, col: s.col, row: s.row, w: s.w, h: s.h,
      status: (codeToOwner.has(s.code) ? 'allocated' : 'available') as 'allocated' | 'available',
      // Reveal the owner's name on ANY of their own booths (multi-booth), never others'.
      occupant: me.stalls.includes(s.code) ? { business_name: me.business_name } : null,
    }))

    return NextResponse.json({
      business_name: me.business_name,
      application_status: me.status,
      tier_label: tierLabel(me.tier),
      placed: !!myStall,
      you: myStall ? { code: myStall.code, zone: TYPE_META[myStall.type].label, status: me.stall_status } : null,
      neighbours,
      stalls, grid: STALL_GRID, zones: STALL_ZONES,
    })
  } catch (e) {
    console.error('exhibitor placement', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
