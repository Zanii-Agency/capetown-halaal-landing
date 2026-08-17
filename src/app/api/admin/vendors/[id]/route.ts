/**
 * PATCH /api/admin/vendors/[id]
 *
 * Amend a vendor's core application fields on the vendor's behalf (Samreen).
 * Whitelisted, role-gated, audited. Writes:
 *   - vendor_applications row: business_name, contact_name, email, phone,
 *     product_categories, preferred_booth_tier, and the
 *     special_requirements.electrical_appliances slice (merged, not clobbered).
 *   - vendor_application_events row { event_type: 'vendor_amended', ... }
 *
 * Auth: admin_users with role 'owner' | 'operator' (same gate as the sibling
 * mark-paid / action endpoints). No new auth helpers invented.
 *
 * Body (all optional, unknown keys ignored):
 *   {
 *     business_name?: string
 *     contact_name?: string
 *     email?: string
 *     phone?: string
 *     product_categories?: string[]
 *     preferred_booth_tier?: string          // must be a key of TIER_META
 *     electrical_appliances?: Record<string, number>  // slug -> qty
 *     electrical_custom?: Array<{ label: string; amount: number; qty?: number }>  // admin off-list charges (per-unit Rand)
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOperator } from '@/lib/admin-rbac'
import { TIER_META, parseAllocation } from '@/lib/stalls'
import { tierPricingFields } from '@/lib/payments/pricing'
import { parsePortalState, updatePortalStateImpl } from '@/lib/portal-state'
import { syncExhibitorAuth } from '@/lib/exhibitor-auth'
import { recordLedger } from '@/lib/zanii-ledger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Electrical slugs the apply form offers. Mirror of ELECTRICAL_OPTIONS in
// src/app/apply/page.tsx and ELECTRICAL_PRICES in src/lib/payments/pricing.ts.
// We constrain edits to this set so pricing/compute stays in sync.
const ELECTRICAL_SLUGS = new Set([
  'charger-lighting', 'microwave', 'urn', 'single-fryer', 'double-fryer',
  'waffle-pancake-maker', 'blender', 'coffee-machine', 'electric-stove',
  'small-display-fridge', 'large-display-fridge-freezer',
])

// special_requirements may live as a JSON string OR an object on the row.
function readReqs(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  if (typeof raw === 'object') return { ...(raw as Record<string, unknown>) }
  return {}
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid application id' }, { status: 400 })
    }

    const gate = await requireOperator()
    if (!gate.ok) return gate.response
    const { adminUser } = gate

    const db = createAdminClient()
    const actorEmail = adminUser.email

    const body = await req.json().catch(() => ({}))

    // Pull the current row so we can merge special_requirements without clobbering
    // the rest of it, and produce a meaningful audit diff.
    const { data: before, error: beforeErr } = await db
      .from('vendor_applications')
      .select('id, business_name, contact_name, email, phone, product_categories, preferred_booth_tier, special_requirements')
      .eq('id', id)
      .single()
    if (beforeErr || !before) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    }

    const update: Record<string, unknown> = {}
    const changed: string[] = []

    // --- string fields (trim, length-cap) ---
    if (typeof body.business_name === 'string') {
      const val = body.business_name.trim()
      if (!val) return NextResponse.json({ error: 'business_name cannot be empty' }, { status: 400 })
      update.business_name = val.slice(0, 200)
      changed.push('business_name')
    }
    if (typeof body.contact_name === 'string') {
      update.contact_name = body.contact_name.trim().slice(0, 200)
      changed.push('contact_name')
    }
    if (typeof body.email === 'string') {
      const val = body.email.trim()
      if (val && !EMAIL_RE.test(val)) {
        return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
      }
      update.email = val.slice(0, 320)
      changed.push('email')
    }
    if (typeof body.phone === 'string') {
      // Keep digits, +, spaces, parens, dashes; reject if no digit present.
      const val = body.phone.trim()
      if (val && !/\d/.test(val)) {
        return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 })
      }
      update.phone = val.replace(/[^\d+()\-\s]/g, '').slice(0, 40)
      changed.push('phone')
    }

    // --- product_categories (string[]) ---
    if (Array.isArray(body.product_categories)) {
      const cats = body.product_categories
        .filter((c: unknown): c is string => typeof c === 'string')
        .map((c: string) => c.trim())
        .filter(Boolean)
        .slice(0, 20)
      update.product_categories = cats
      changed.push('product_categories')
    }

    // --- preferred_booth_tier (constrained to TIER_META keys) ---
    let newTier: string | null = null
    if (typeof body.preferred_booth_tier === 'string') {
      const tier = body.preferred_booth_tier.trim()
      if (tier && !TIER_META[tier]) {
        return NextResponse.json(
          { error: `Invalid stall tier: ${tier}`, valid_tiers: Object.keys(TIER_META) },
          { status: 400 }
        )
      }
      update.preferred_booth_tier = tier || null
      changed.push('preferred_booth_tier')
      if (tier) newTier = tier
    }

    // --- special_requirements slices (electrical_appliances + electrical_custom) ---
    // Both edit the same JSON blob, so read it once, apply each touched slice,
    // and write once at the end. Untouched slices are left intact (no clobber).
    let reqsDirty = false
    const reqs = readReqs((before as { special_requirements?: unknown }).special_requirements)

    // Tier changed → sync the frozen pricing snapshot (stall_type/stall_price/
    // total_estimate) so the admin application page + invoice line stop showing
    // the OLD size. This is the universal wall: EVERY preferred_booth_tier writer
    // (here + the stall-change approve) routes the price through tierPricingFields.
    if (newTier) {
      const fields = tierPricingFields(newTier, reqs as { stall_price?: number; total_estimate?: number })
      if (fields) { Object.assign(reqs, fields); reqsDirty = true }
    }

    // electrical_appliances: slug -> qty, whitelisted, merged into the blob.
    if (body.electrical_appliances && typeof body.electrical_appliances === 'object' && !Array.isArray(body.electrical_appliances)) {
      const cleaned: Record<string, number> = {}
      for (const [slug, qty] of Object.entries(body.electrical_appliances as Record<string, unknown>)) {
        if (!ELECTRICAL_SLUGS.has(slug)) continue // whitelist only
        const q = Math.max(0, Math.floor(Number(qty) || 0))
        if (q > 0) cleaned[slug] = q
      }
      reqs.electrical_appliances = cleaned
      reqsDirty = true
      changed.push('electrical_appliances')
    }

    // electrical_custom: admin-set off-list charges. Shape is
    // Array<{ label, amount, qty? }>. We REPLACE the whole array (not merge) so
    // removing a row in the UI actually removes the charge. Invalid or
    // blank-label entries are dropped. amount is per-unit Rand, qty defaults to 1.
    if (Array.isArray(body.electrical_custom)) {
      const cleanedCustom: Array<{ label: string; amount: number; qty: number }> = []
      for (const raw of body.electrical_custom as unknown[]) {
        if (!raw || typeof raw !== 'object') continue
        const e = raw as { label?: unknown; amount?: unknown; qty?: unknown }
        const amount = Number(e.amount)
        // The amount is what charges. Keep any finite amount > 0 even if the
        // label is blank (default it), so an operator can add a charge by just
        // typing an amount. Only drop empty/zero/negative amounts.
        if (!Number.isFinite(amount) || amount <= 0) continue
        const label = (typeof e.label === 'string' && e.label.trim().slice(0, 60)) || 'Additional charge'
        const qty = Math.max(1, Math.floor(Number(e.qty) || 1))
        cleanedCustom.push({ label, amount, qty })
      }
      reqs.electrical_custom = cleanedCustom
      reqsDirty = true
      changed.push('electrical_custom')
    }

    if (reqsDirty) {
      // Persist as a JSON string to match how the apply form writes the column.
      update.special_requirements = JSON.stringify(reqs)
    }

    if (changed.length === 0) {
      return NextResponse.json({ error: 'No editable fields supplied' }, { status: 400 })
    }

    const { data: after, error: updErr } = await db
      .from('vendor_applications')
      .update(update)
      .eq('id', id)
      .select('id, business_name, contact_name, email, phone, product_categories, preferred_booth_tier, special_requirements')
      .single()
    if (updErr || !after) {
      console.error('[vendors PATCH] update error:', updErr?.message)
      return NextResponse.json({ error: updErr?.message || 'Update failed' }, { status: 500 })
    }

    // Propagate the amend to the Supabase Auth login identity. The vendor logs in
    // via auth.users.email — a store separate from vendor_applications.email — so
    // an email edit here must move the login too, or the vendor is silently locked
    // out (corrected email, no account answers to it). Look up by the OLD email
    // (before.email) which is what the auth account answered to. Non-fatal.
    let authSync: { updated: boolean; userId?: string; error?: string } | undefined
    if (changed.includes('email') || changed.includes('business_name')) {
      authSync = await syncExhibitorAuth({
        oldEmail: (before as { email?: string }).email || '',
        newEmail: changed.includes('email') ? (after.email as string) : undefined,
        businessName: changed.includes('business_name') ? (after.business_name as string) : undefined,
      })
      if (authSync.error) console.warn('[vendors PATCH] auth sync error:', authSync.error)
    }

    // Audit row — never block the response on a logging failure.
    try {
      await db.from('vendor_application_events').insert({
        application_id: id,
        event_type: 'vendor_amended',
        after_value: { changed, fields: update, auth_sync: authSync ?? null },
        actor_email: actorEmail,
        actor_role: 'operator',
        note: `Amended ${changed.join(', ')}`,
      })
    } catch (e) {
      console.warn('[vendors PATCH] event log insert failed:', (e as Error).message)
    }

    // Signed proof-of-action: an admin amended a vendor. Reached only after a
    // successful update (changed.length > 0). NO personal names/emails in the
    // payload (privacy) — the cth.admin DID + the changed-fields list are the
    // distinction. Best-effort: recordLedger never throws.
    await recordLedger('samreen', 'cth.admin.vendor-edit', {
      application_id: id,
      changed,
    })

    return NextResponse.json({ ok: true, updated: after, changed, authSync })
  } catch (err) {
    console.error('[vendors PATCH] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/admin/vendors/[id]
 *
 * Withdraw a vendor that no longer wants to trade. This is a SOFT delete, not a
 * row drop: the DB status column has a CHECK constraint (pending|approved|
 * rejected|info_requested) and DDL is blocked (doctrine Law 8), and most child
 * FKs cascade on delete, so a hard delete would irreversibly wipe the vendor's
 * documents, payments, threads and audit trail. Instead we:
 *   1. Release every stall the vendor holds back to the floor (strip ⟦STALL⟧).
 *   2. Stamp a ⟦PORTAL⟧ `withdrawn` marker (who/when/reason/freed stalls).
 *   3. Set status='rejected' so the vendor drops out of every approved-vendor
 *      list (vendors page, allocation panel, CSV export) in a single write.
 * The marker distinguishes a withdrawal from a genuine rejection and makes the
 * action reversible (re-approve under Applications).
 *
 * Body (optional): { reason?: string }
 * Auth: owner | operator (same gate as PATCH / mark-paid).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid application id' }, { status: 400 })
    }

    const gate = await requireOperator()
    if (!gate.ok) return gate.response
    const { adminUser } = gate

    const db = createAdminClient()
    const actorEmail = adminUser.email

    const body = await req.json().catch(() => ({}))
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 280) : ''

    const { data: before, error: beforeErr } = await db
      .from('vendor_applications')
      .select('id, business_name, status, admin_notes')
      .eq('id', id)
      .single()
    if (beforeErr || !before) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    }

    const notes = (before.admin_notes as string) || ''
    // parseAllocation().human strips the ⟦STALL⟧ marker but keeps prose + the
    // ⟦PORTAL⟧ marker, freeing the booth(s). Capture the freed codes for the audit.
    const { stalls: freedStalls, human: notesNoStall } = parseAllocation(notes)
    const state = parsePortalState(notes)
    const nowIso = new Date().toISOString()
    state.withdrawn = {
      at: nowIso,
      by: actorEmail ?? null,
      ...(reason ? { reason } : {}),
      ...(freedStalls.length ? { freed_stalls: freedStalls } : {}),
    }
    // updatePortalStateImpl re-writes the ⟦PORTAL⟧ marker on notesNoStall,
    // preserving prose. Net result: no stall marker, refreshed portal marker.
    const newNotes = updatePortalStateImpl(notesNoStall, state)

    const { error: updErr } = await db
      .from('vendor_applications')
      .update({ status: 'rejected', admin_notes: newNotes })
      .eq('id', id)
    if (updErr) {
      console.error('[vendors DELETE] update error:', updErr.message)
      return NextResponse.json({ error: updErr.message || 'Withdraw failed' }, { status: 500 })
    }

    // Audit row — never block the response on a logging failure.
    try {
      await db.from('vendor_application_events').insert({
        application_id: id,
        event_type: 'vendor_withdrawn',
        before_value: { status: before.status, stalls: freedStalls },
        after_value: { status: 'rejected', withdrawn: state.withdrawn },
        actor_email: actorEmail,
        actor_role: 'operator',
        note: reason ? `Vendor withdrawn: ${reason}` : 'Vendor withdrawn (no longer trading)',
      })
    } catch (e) {
      console.warn('[vendors DELETE] event log insert failed:', (e as Error).message)
    }

    return NextResponse.json({
      ok: true,
      withdrawn: true,
      business_name: before.business_name,
      freed_stalls: freedStalls,
    })
  } catch (err) {
    console.error('[vendors DELETE] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
