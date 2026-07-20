import type { VendorApplication } from '@/lib/supabase/types'
import { parsePortalState } from '@/lib/portal-state'
import { scoreCompleteness } from './completeness'

/**
 * Predicates for the smart-queue filter chips.
 * Each takes a single application row and returns boolean.
 * Pure: no IO, safe to run inside reduce/filter loops.
 */

const READY_THRESHOLD = 80
const PENDING_AGE_DAYS = 30

export function isReadyToApprove(row: VendorApplication): boolean {
  if (row.status !== 'pending') return false
  const score =
    typeof row.completeness_score === 'number'
      ? row.completeness_score
      : scoreCompleteness(row)
  return score >= READY_THRESHOLD
}

export function needsDocs(row: VendorApplication): boolean {
  // Treat row as needing docs if completeness drops below the "ready" cliff
  // OR there's no documents array attached.
  const docs = row.documents
  const hasDocs = Array.isArray(docs) && docs.length > 0
  if (hasDocs) return false
  const score =
    typeof row.completeness_score === 'number'
      ? row.completeness_score
      : scoreCompleteness(row)
  return score < READY_THRESHOLD
}

export function noPhone(row: VendorApplication): boolean {
  return !row.phone || row.phone.trim().length === 0
}

export function noEmail(row: VendorApplication): boolean {
  return !row.email || row.email.trim().length === 0
}

export function over30dPending(row: VendorApplication, now: Date = new Date()): boolean {
  if (row.status !== 'pending') return false
  const created = new Date(row.created_at)
  if (Number.isNaN(created.getTime())) return false
  const ageDays = (now.getTime() - created.getTime()) / 86_400_000
  return ageDays > PENDING_AGE_DAYS
}

export function isDuplicateCandidate(row: VendorApplication): boolean {
  return typeof row.dup_marker === 'string' && row.dup_marker.trim().length > 0
}

export function hasContractSigned(row: VendorApplication): boolean {
  // Contract-signed truth: the column the /exhibitor/contract/sign route stamps.
  // NOTHING ever writes a literal ⟦CONTRACT:signed⟧ marker, so the old
  // admin_notes regex always matched zero rows. Mirrors the whatsapp-broadcast
  // isContractSignedRow() fix.
  return !!row.contract_signed_at
}

export function hasPaid(row: VendorApplication): boolean {
  // Single source of "paid" truth, mirroring whatsapp-broadcast isPaidRow() and
  // lib/exhibitor-paygate.ts isPaid(): a vendor counts as paid when the
  // first-class column says so (Yoco webhook / admin mark-paid via confirm.ts,
  // which also stamps paid_at on a fee waiver) OR the legacy ⟦PORTAL:..⟧
  // base64 portal-state marker does. NO code ever writes a literal ⟦PAID⟧
  // marker, so the old notes regex always matched zero rows.
  if (row.payment_status === 'paid') return true
  if (row.paid_at) return true
  return parsePortalState(row.admin_notes).payment?.status === 'paid'
}

export function hasDocs(row: VendorApplication): boolean {
  return Array.isArray(row.documents) && row.documents.length > 0
}

export function tradedBefore(row: VendorApplication): boolean {
  if (!row.special_requirements) return false
  try {
    const parsed = JSON.parse(row.special_requirements) as Record<string, unknown>
    const v = parsed?.traded_before
    if (typeof v === 'boolean') return v
    if (typeof v === 'string') {
      const norm = v.trim().toLowerCase()
      return norm === 'yes' || norm === 'true' || norm === 'y' || norm === '1'
    }
  } catch {
    /* ignore */
  }
  return false
}

export type BucketKey =
  | 'ready_to_approve'
  | 'needs_docs'
  | 'no_phone'
  | 'no_email'
  | 'over_30d_pending'
  | 'duplicates'
  | 'has_email'
  | 'has_phone'
  | 'has_docs'
  | 'contract_signed'
  | 'paid'
  | 'traded_before'

export function matchesBucket(row: VendorApplication, bucket: BucketKey): boolean {
  switch (bucket) {
    case 'ready_to_approve':
      return isReadyToApprove(row)
    case 'needs_docs':
      return needsDocs(row)
    case 'no_phone':
      return noPhone(row)
    case 'no_email':
      return noEmail(row)
    case 'over_30d_pending':
      return over30dPending(row)
    case 'duplicates':
      return isDuplicateCandidate(row)
    case 'has_email':
      return !noEmail(row)
    case 'has_phone':
      return !noPhone(row)
    case 'has_docs':
      return hasDocs(row)
    case 'contract_signed':
      return hasContractSigned(row)
    case 'paid':
      return hasPaid(row)
    case 'traded_before':
      return tradedBefore(row)
    default:
      return true
  }
}
