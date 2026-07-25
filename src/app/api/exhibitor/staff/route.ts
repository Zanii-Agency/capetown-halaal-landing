import { NextRequest, NextResponse, after } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import {
  updatePortalState,
  parsePortalState,
  type StaffMember,
  type StaffRole,
  STAFF_ROLES,
} from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { stripAllHtml } from '@/lib/sanitize'
import { normalizePhone } from '@/lib/phone/normalize'
import {
  createStaffBadgeOrder,
  cancelStaffBadgeOrder,
  STAFF_BADGE_PRODUCT_ID,
  getOrders,
} from '@/lib/woocommerce'

export const runtime = 'nodejs'
// FooEvents post-insert lag + the self-rendered badge (puppeteer/chromium) push
// this path past Vercel's default window. The badge render runs in after() so
// the vendor response returns fast, but the function stays alive up to here.
export const maxDuration = 60

// Samreen sign-off 2026-06-08: a vendor may register at most this many staff
// badges total. The cap is enforced both client-side (StaffManager hides the
// add form) and server-side (this route refuses the create). The same cap
// counts existing portal_state.staff entries + any prior WC staff-badge orders
// (defensive read in case portal_state was cleared but WC has receipts).
const GATE_ACCESS_CAP = 3

// ─── input shape + sanitisation ─────────────────────────────────────────────
const SA_PHONE_RE = /^\+27\d{9}$/
const SA_ID_RE = /^[0-9]{6,13}$/
// SA vehicle reg is regionally varied (CA, CY, CL, GP, ...). Accept 4-10
// alphanumerics with optional whitespace/dash; strip everything else.
const VEHICLE_REG_RE = /^[A-Z0-9\- ]{4,12}$/

function cleanString(input: unknown, max = 80): string {
  const stripped = stripAllHtml(String(input ?? '')).trim()
  // strip control + RTL/LTR override chars
  return stripped.replace(/[\x00-\x1f\x7f\u200e\u200f\u202a-\u202e]/g, '').slice(0, max)
}

interface StaffInput {
  name: string
  phone?: string
  id_number?: string
  vehicle_reg?: string
  role?: string
}

interface CleanedStaff {
  name: string
  phoneE164: string
  id_number: string
  vehicle_reg: string
  role: StaffRole
}
type ValidationResult =
  | { ok: true; cleaned: CleanedStaff }
  | { ok: false; error: string }

function validate(raw: StaffInput): ValidationResult {
  const name = cleanString(raw.name, 80)
  if (name.length < 2) return { ok: false, error: 'Name is required (min 2 characters)' }

  // Phone is now the primary identifier (replacing SA ID per 2026-06-11 portal change).
  // We still accept id_number for backwards compat; at least one must be present.
  let phoneE164 = ''
  if (raw.phone) {
    const norm = normalizePhone(raw.phone)
    if (!norm.ok || !SA_PHONE_RE.test(norm.e164)) {
      return { ok: false, error: 'Phone must be a valid South African mobile number' }
    }
    phoneE164 = norm.e164
  }

  let id_number = ''
  if (raw.id_number) {
    id_number = cleanString(raw.id_number, 13).replace(/\D/g, '')
    if (id_number && !SA_ID_RE.test(id_number)) {
      return { ok: false, error: 'ID number is not valid' }
    }
  }
  if (!phoneE164 && !id_number) {
    return { ok: false, error: 'Provide a phone number (preferred) or ID number' }
  }

  let vehicle_reg = ''
  if (raw.vehicle_reg) {
    vehicle_reg = cleanString(raw.vehicle_reg, 12).toUpperCase().replace(/[^A-Z0-9\- ]/g, '')
    if (vehicle_reg && !VEHICLE_REG_RE.test(vehicle_reg)) {
      return { ok: false, error: 'Vehicle registration looks malformed' }
    }
  }

  const roleRaw = (raw.role ? String(raw.role).toLowerCase().trim() : 'staff')
  const role: StaffRole = (STAFF_ROLES as readonly string[]).includes(roleRaw)
    ? (roleRaw as StaffRole)
    : 'staff'

  return { ok: true, cleaned: { name, phoneE164, id_number, vehicle_reg, role } }
}

// ─── handlers ───────────────────────────────────────────────────────────────

// GET: list the signed-in vendor's registered staff.
export async function GET() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const state = parsePortalState(ctx.application.admin_notes as string)
  // Only ACTIVE badges. Admin revokes leave a revoked_at tombstone in the roster
  // (getBadgeAllocation already filters these); the vendor view + count must too,
  // else a revoked member counts against the cap and hides the add form.
  return NextResponse.json({ staff: (state.staff || []).filter((m) => !m.revoked_at), cap: GATE_ACCESS_CAP })
}

// POST: add a staff member. Creates the WC staff-badge order, captures the
// FooEvents ticket id, persists everything on portal_state.
export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const application = ctx.application
  const applicationId = application.id as string

  const body = await req.json().catch(() => ({}))
  const v = validate(body as StaffInput)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  const cleaned = v.cleaned

  // Cap-check uses BOTH the portal_state roster and any prior WC orders the
  // vendor already placed against the staff-badge product. Belt+braces: portal
  // state can drift if an admin cleared it manually, but FooEvents tickets are
  // canonical for what's printed at the gate (Law 4).
  // Count ACTIVE badges only. A revoked (admin-removed) member leaves a
  // revoked_at tombstone in the roster; counting it here blocks the vendor from
  // re-adding up to the real cap (the KOCO-class "portal won't let me add" bug).
  const existingStaff = (parsePortalState(application.admin_notes as string).staff || []).filter((m) => !m.revoked_at)
  let priorOrders = 0
  try {
    const orders = await getOrders({ status: 'completed,processing', product: String(STAFF_BADGE_PRODUCT_ID) })
    priorOrders = orders.filter((o) =>
      o.line_items.some((li) => li.product_id === STAFF_BADGE_PRODUCT_ID) &&
      // tag-match: only count orders that name THIS vendor application
      o.billing.email?.toLowerCase() === String(application.email || '').toLowerCase(),
    ).length
  } catch (e) {
    // WC blip: fall back to portal_state count alone rather than block the vendor.
    console.warn('[staff] WC pre-count failed, using portal_state only:', e)
  }
  const effective = Math.max(existingStaff.length, priorOrders)
  if (effective >= GATE_ACCESS_CAP) {
    return NextResponse.json({
      error: `You have reached the ${GATE_ACCESS_CAP}-badge limit for this stall. Remove a member to swap.`,
    }, { status: 409 })
  }

  const stall = parseAllocation(application.admin_notes as string).stall
  const vendorContact = String(application.contact_name || application.business_name || 'Vendor')
  const [first, ...rest] = vendorContact.split(/\s+/).filter(Boolean)
  const vendorFirstName = first || 'Vendor'
  const vendorLastName = rest.join(' ') || String(application.business_name || '')
  // .trim(): a stored trailing space rendered the owner alert as "Krispy Corn Dog : Junaid"
  const businessName = String(application.business_name || 'Vendor').trim() || 'Vendor'
  const vendorEmail = String(application.email || '')
  const vendorPhone = String(application.phone || cleaned.phoneE164)

  const portalStaffId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  // Create the WC order FIRST. If WC fails we never write half-state to
  // portal_state — vendor sees the error and retries.
  let wcResult: Awaited<ReturnType<typeof createStaffBadgeOrder>> | null = null
  try {
    wcResult = await createStaffBadgeOrder({
      vendorApplicationId: applicationId,
      vendorFirstName,
      vendorLastName,
      vendorEmail,
      vendorPhone,
      vendorBusinessName: businessName,
      stallCode: stall,
      staff: {
        name: cleaned.name,
        id_number: cleaned.id_number,
        vehicle_reg: cleaned.vehicle_reg,
        role: cleaned.role,
        portalStaffId,
      },
    })
  } catch (e) {
    console.error('[staff] createStaffBadgeOrder failed:', e)
    return NextResponse.json({
      error: 'Could not generate badge. WhatsApp Samreen if this keeps happening.',
    }, { status: 502 })
  }

  const member: StaffMember = {
    id: portalStaffId,
    name: cleaned.name,
    phone: cleaned.phoneE164 || undefined,
    id_number: cleaned.id_number,
    vehicle_reg: cleaned.vehicle_reg,
    role: cleaned.role,
    added_at: new Date().toISOString(),
    wc_order_id: wcResult.id,
    wc_order_number: wcResult.number || String(wcResult.id),
    fooevents_ticket_id: wcResult.fooevents_ticket_id,
    ticket_pdf_url: wcResult.ticket_pdf_url,
  }

  const next = await updatePortalState(applicationId, (s) => ({
    ...s,
    staff: [...(s.staff || []), member],
  }))

  // Deliver the badge we render OURSELVES (QR = wc_order_id, scannable at the
  // gate) over email + WhatsApp. Runs AFTER the 200 via after() so the vendor's
  // add returns fast; the chromium render happens post-response. Never blocks
  // or fails the add (KT #206655 — self-render replaces the broken FooEvents PDF).
  after(async () => {
    try {
      const { deliverBadge } = await import('@/lib/badges/deliver-badge')
      const r = await deliverBadge({
        name: cleaned.name,
        role: cleaned.role,
        businessName,
        stall,
        phone: cleaned.phoneE164 || undefined,
        vehicleReg: cleaned.vehicle_reg,
        wcOrderId: wcResult!.id,
        vendorPhone,
        vendorEmail,
      })
      console.log('[staff] badge delivered', JSON.stringify(r))
    } catch (e) {
      console.error('[staff] deliverBadge failed:', (e as Error).message)
    }
  })

  // Best-effort owner notification. Failure here never blocks the vendor's add.
  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({
      event: 'system_alert',
      body: `Staff badge added by ${businessName}: ${cleaned.name}.`,
      audience: 'all',
      vendorId: applicationId, // EFT-lane vendors' self-service stays on master
    })
  } catch (e) {
    console.error('[staff] notifyOwners failed:', (e as Error).message)
  }

  return NextResponse.json({ success: true, staff: (next.staff || []).filter((m) => !m.revoked_at), member })
}

// DELETE: remove a staff member by ?id=. Also cancels the underlying WC order
// so FooEvents invalidates the ticket. Soft-delete: we keep a tombstone row
// with revoked_at so admin/audit still sees the history.
export async function DELETE(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const applicationId = ctx.application.id as string
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const state = parsePortalState(ctx.application.admin_notes as string)
  const target = (state.staff || []).find((m) => m.id === id)
  if (target?.wc_order_id) {
    try {
      await cancelStaffBadgeOrder(target.wc_order_id)
    } catch (e) {
      console.warn('[staff] cancelStaffBadgeOrder failed (continuing with portal delete):', e)
    }
  }

  const next = await updatePortalState(applicationId, (s) => ({
    ...s,
    staff: (s.staff || []).filter((m) => m.id !== id),
  }))
  return NextResponse.json({ success: true, staff: (next.staff || []).filter((m) => !m.revoked_at) })
}
