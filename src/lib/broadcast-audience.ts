// =============================================================================
// Broadcast audience — the ONE place "who receives this blast" is decided.
//
// Both the counts/dispatch route (api/admin/whatsapp-broadcast) and the preview
// route (api/admin/broadcast/preview) build their audience here. They used to
// each carry a private copy of isPaidRow + buildAudience, and the copies had
// already drifted: both matched only payment.status === 'paid', silently
// dropping the canonical 'waived' and 'collected' paid states, so waived /
// collected vendors read as UNPAID in every broadcast filter. One module, one
// predicate, no drift.
//
// CTH Law 8: there is NO payment_status or portal_stage column on the live CTH
// Supabase. Every lifecycle signal below is derived from the columns that DO
// exist (status, paid_at, contract_signed_at) plus the admin_notes markers
// (⟦DOCS:complete⟧, ⟦STALL:..⟧, ⟦PORTAL:<base64>⟧). Nothing here reads a phantom
// column.
// =============================================================================

import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, hasPaid } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'

export const AUDIENCE_COLUMNS =
  'id, business_name, contact_name, email, phone, preferred_booth_tier, product_categories, status, admin_notes, paid_at, contract_signed_at'

export interface AudienceRow {
  id: string
  business_name: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  preferred_booth_tier: string | null
  product_categories: string[] | null
  status: string | null
  admin_notes: string | null
  paid_at: string | null
  contract_signed_at: string | null
}

const DOCS_COMPLETE_MARKER = '⟦DOCS:complete⟧'

/** The portal-state payment status, or 'none' when unset. */
export function paymentStatusOf(r: AudienceRow): string {
  return parsePortalState(r.admin_notes).payment?.status || 'none'
}

/**
 * Single source of paid truth. Reuses lib/portal-state hasPaid() (which covers
 * the canonical paid | waived | collected states plus the inner payment.paid_at)
 * OR'd with the first-class paid_at column (Yoco webhook / admin mark-paid). The
 * old broadcast copies matched only status === 'paid', dropping waived/collected.
 */
export function isPaidRow(r: AudienceRow): boolean {
  return !!r.paid_at || hasPaid(parsePortalState(r.admin_notes))
}

export function isContractSignedRow(r: AudienceRow): boolean {
  return !!r.contract_signed_at
}

/** Has a ⟦STALL:..⟧ allocation marker on admin_notes (floor-plan placed). */
export function isAllocatedRow(r: AudienceRow): boolean {
  return parseAllocation(r.admin_notes).stalls.length > 0
}

export function hasDocsComplete(r: AudienceRow): boolean {
  return (r.admin_notes || '').includes(DOCS_COMPLETE_MARKER)
}

// ---------------------------------------------------------------------------
// Lifecycle stage — the "stage of existence" a vendor has reached. Every row
// lands in exactly ONE bucket (the deepest stage it satisfies), so this is a
// clean single-select funnel filter. 'rejected' is a terminal side-exit and
// wins over funnel depth.
// ---------------------------------------------------------------------------

export type VendorStage =
  | 'applied'    // pending review (default)
  | 'info'       // info requested
  | 'approved'   // approved, not yet allocated
  | 'allocated'  // stall allocated, awaiting contract
  | 'contract'   // contract signed, not yet paid
  | 'paid'       // money settled (paid / waived / collected)
  | 'rejected'   // rejected

export const STAGE_ORDER: VendorStage[] = [
  'applied', 'info', 'approved', 'allocated', 'contract', 'paid', 'rejected',
]

export const STAGE_LABELS: Record<VendorStage, string> = {
  applied: 'Applied (pending review)',
  info: 'Info requested',
  approved: 'Approved, not allocated',
  allocated: 'Allocated, awaiting contract',
  contract: 'Contract signed, unpaid',
  paid: 'Paid / confirmed',
  rejected: 'Rejected',
}

export function vendorStage(r: AudienceRow): VendorStage {
  if (r.status === 'rejected') return 'rejected'
  if (isPaidRow(r)) return 'paid'
  if (isContractSignedRow(r)) return 'contract'
  if (r.status === 'approved') return isAllocatedRow(r) ? 'allocated' : 'approved'
  if (r.status === 'info_requested') return 'info'
  return 'applied'
}

// ---------------------------------------------------------------------------
// Paid filter — a small enum over the real payment states, replacing the old
// binary yes/no. Grounded selectors: 'deferred' = on a payment plan (not yet
// counted as paid), 'waived' = fee waived (counts as settled).
// ---------------------------------------------------------------------------

export type PaidFilter = 'paid' | 'unpaid' | 'deferred' | 'waived'
export const PAID_FILTERS: PaidFilter[] = ['paid', 'unpaid', 'deferred', 'waived']

export const PAID_FILTER_LABELS: Record<PaidFilter, string> = {
  paid: 'Stall fee paid',
  unpaid: 'Stall fee unpaid',
  deferred: 'On a payment plan',
  waived: 'Fee waived',
}

export function matchesPaid(r: AudienceRow, paid: PaidFilter): boolean {
  switch (paid) {
    case 'paid': return isPaidRow(r)
    case 'unpaid': return !isPaidRow(r)
    case 'deferred': return paymentStatusOf(r) === 'deferred'
    case 'waived': return paymentStatusOf(r) === 'waived'
  }
}

// ---------------------------------------------------------------------------
// Filters + matching.
// ---------------------------------------------------------------------------

export interface BroadcastFilters {
  status?: string | null
  sector?: string | null
  booth_tier?: string | null
  stage?: VendorStage | null
  has_docs?: boolean | null
  contract_signed?: boolean | null
  paid?: PaidFilter | null
}

/** In-process predicates only. status / booth_tier / sector are pushed to SQL. */
export function rowMatchesFilters(r: AudienceRow, f: BroadcastFilters): boolean {
  if (f.has_docs === true && !hasDocsComplete(r)) return false
  if (f.has_docs === false && hasDocsComplete(r)) return false
  if (f.contract_signed === true && !isContractSignedRow(r)) return false
  if (f.contract_signed === false && isContractSignedRow(r)) return false
  if (f.paid && !matchesPaid(r, f.paid)) return false
  if (f.stage && vendorStage(r) !== f.stage) return false
  return true
}

// ---------------------------------------------------------------------------
// Filter parsing — from a query string (GET counts / preview sample) and from
// a JSON body (dispatch POST / preview POST). asPaid keeps back-compat with the
// old paid=true|false booleans in case a stale client is still in flight.
// ---------------------------------------------------------------------------

function parseBool(v: string | null | undefined): boolean | null {
  if (v == null) return null
  if (v === '1' || v === 'true' || v === 'yes') return true
  if (v === '0' || v === 'false' || v === 'no') return false
  return null
}

const STAGE_SET = new Set<string>(STAGE_ORDER)
function asStage(v: string | null | undefined): VendorStage | null {
  return v && STAGE_SET.has(v) ? (v as VendorStage) : null
}

const PAID_SET = new Set<string>(PAID_FILTERS)
function asPaid(v: string | null | undefined): PaidFilter | null {
  if (v == null || v === '') return null
  if (v === 'true' || v === '1' || v === 'yes') return 'paid'   // legacy boolean
  if (v === 'false' || v === '0' || v === 'no') return 'unpaid' // legacy boolean
  return PAID_SET.has(v) ? (v as PaidFilter) : null
}

export function filtersFromSearch(p: URLSearchParams): BroadcastFilters {
  return {
    status: p.get('status') || null,
    sector: p.get('sector') || null,
    booth_tier: p.get('booth_tier') || null,
    stage: asStage(p.get('stage')),
    has_docs: parseBool(p.get('has_docs')),
    contract_signed: parseBool(p.get('contract_signed')),
    paid: asPaid(p.get('paid')),
  }
}

export function filtersFromBody(b: Record<string, unknown> | null | undefined): BroadcastFilters {
  const str = (k: string) => (b && b[k] != null && b[k] !== '' ? String(b[k]) : null)
  const bool = (k: string) => (b == null || b[k] == null ? null : Boolean(b[k]))
  return {
    status: str('status'),
    sector: str('sector'),
    booth_tier: str('booth_tier'),
    stage: asStage(str('stage')),
    has_docs: bool('has_docs'),
    contract_signed: bool('contract_signed'),
    paid: asPaid(str('paid')),
  }
}

// ---------------------------------------------------------------------------
// Audience builder. status / booth_tier / sector push down to the query; the
// derived predicates (docs / contract / paid / stage) filter in-process because
// they read admin_notes markers that are not indexed.
// ---------------------------------------------------------------------------

export async function buildAudience(f: BroadcastFilters): Promise<AudienceRow[]> {
  const admin = createAdminClient()
  let q = admin.from('vendor_applications').select(AUDIENCE_COLUMNS)
  if (f.status) q = q.eq('status', f.status)
  if (f.booth_tier) q = q.eq('preferred_booth_tier', f.booth_tier)
  if (f.sector) q = q.contains('product_categories', [f.sector])

  const { data, error } = await q
  if (error) {
    console.error('buildAudience query error', error)
    return []
  }
  return ((data || []) as AudienceRow[]).filter((r) => rowMatchesFilters(r, f))
}
