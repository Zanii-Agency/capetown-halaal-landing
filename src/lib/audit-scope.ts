// Lane scoping for the admin activity feed (/api/admin/activity).
//
// Taona 2026-07-28: "audit log is reporting eft lane and eft related info on
// smareens account which is wrong". The route authenticated the caller and then
// applied NO lane filter at all, so every admin role saw every audit row.
//
// Measured on live rows at the time of the fix, over the 271 most recent
// vendor_application_events:
//   148  about vendors outside her scope
//     7  carrying EFT wording in their own text
// site_events was clean (0 of 300), but is filtered too so a future event type
// cannot quietly reopen this.
//
// TWO INDEPENDENT CHECKS, BECAUSE ONE IS NOT ENOUGH.
//
// The vendor check alone does not close this. Y&K gifts and toys was moved into
// her scope on purpose (its payment was marked so she would see it as settled),
// and its audit trail still contains `eft_lane_add` and `eft_lane_unexclude`.
// A vendor-scope filter would hand her the exact rows describing the
// arrangement, on the one vendor it most matters for. So the event's own text
// is checked separately, for every vendor including hers.
//
// Same shape as the inbox: a vendor gate, then a message-level gate.

import { revealsPaymentArrangement } from '@/lib/eft'

/** Audit rows that describe lane MECHANICS rather than vendor activity. These
 *  are withheld from the festival owner whoever they are about, because the
 *  action itself is the thing she must not see. Matched by prefix so a future
 *  `eft_lane_*` variant is covered on the day it is written, not the day
 *  someone remembers this list. */
export function isLaneMechanicsEvent(eventType: string | null | undefined): boolean {
  return (eventType || '').toLowerCase().startsWith('eft_lane')
}

/** Events only the master may see, regardless of lane.
 *
 *  admin_login is here because of a hole THIS SESSION opened: login tracking
 *  was added at Taona's request ("I need to know" where she signs in from) and
 *  it writes to site_events, which this same feed renders. Without this she
 *  would read her own surveillance record and, worse, Taona's IP and city. A
 *  monitoring feature visible to the monitored party is not a monitoring
 *  feature. */
export const MASTER_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(['admin_login'])

export interface AuditRow {
  event_type?: string | null
  note?: string | null
  /** before/after are JSONB diffs, not strings, so they are stringified before
   *  the text check: EFT wording nested inside a diff payload reads as an
   *  object to a naive check and would slip straight through. */
  before_value?: unknown
  after_value?: unknown
  /** Serialised metadata for site_events rows; ignored when absent. */
  metadata?: unknown
}

/** Flatten any of the row's value shapes to searchable text. JSON.stringify
 *  throws on a circular structure, which must not take the whole feed down;
 *  an unreadable value is treated as suspicious and reported as such. */
function asText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return 'eft' /* unreadable: fail closed */ }
}

/** Should this audit row be withheld from the festival owner?
 *
 *  `vendorInScope` is a tri-state on purpose:
 *    true      the row is about a vendor she owns
 *    false     the row is about a vendor she does not
 *    undefined the row names no vendor, or the vendor could not be resolved
 *
 *  undefined withholds. An unresolvable row cannot be PROVEN hers, and the
 *  costs are asymmetric: a hidden csv_export line is an inconvenience, a
 *  visible lane row is the breach this module exists to stop. */
export function hiddenFromOwner(row: AuditRow, vendorInScope: boolean | undefined): boolean {
  const type = row.event_type || ''
  if (MASTER_ONLY_EVENT_TYPES.has(type)) return true
  if (isLaneMechanicsEvent(type)) return true

  // The row's own words. Catches `payment_manual` notes reading "Marked paid
  // manually by admin (eft)." on vendors who ARE hers.
  const text = [type, asText(row.note), asText(row.before_value),
    asText(row.after_value), asText(row.metadata)].join(' ')
  if (revealsPaymentArrangement(text)) return true

  return vendorInScope !== true
}

/** site_events usually name no vendor, so they are judged on content alone.
 *  When the caller CAN resolve the vendor (metadata.vendor_id or
 *  metadata.application_id), pass `vendorInScope` so vendor-tied events such as
 *  `vendor_doc_uploaded` for a master-lane vendor are hidden from the festival
 *  owner. Undefined means the vendor is unknown / not applicable, and the row
 *  is then judged on content only. */
export function siteEventHiddenFromOwner(row: AuditRow, vendorInScope?: boolean): boolean {
  const type = row.event_type || ''
  if (MASTER_ONLY_EVENT_TYPES.has(type)) return true
  if (isLaneMechanicsEvent(type)) return true
  if (vendorInScope === false) return true
  return revealsPaymentArrangement([type, asText(row.note), asText(row.metadata)].join(' '))
}

/** Activity rows that give away that a vendor was shown, or paid into, an EFT
 *  account: the "Eft Details Revealed" / "Eft Proof Uploaded" lines on the
 *  vendor profile log (Taona 2026-10-14). Hidden from non-EFT-admin viewers on
 *  master-lane vendors; the rest of the log (logo, approval, docs) stays. */
export function revealsLaneActivity(eventType: string | null | undefined): boolean {
  const t = (eventType || '').toLowerCase()
  return t.startsWith('eft_') || t === 'payment_proof_uploaded'
}

/** The 12 master-lane vendors the team already saw on the profile log and listed
 *  as "PoP Recon - Incorrect Acc" (Website Development group, 2026-10-13). Their
 *  log stays as the team already saw it (Taona 2026-10-14); every OTHER master-lane
 *  vendor's EFT rows are hidden. Explicit ids, never a pattern. */
export const LANE_ACTIVITY_ALREADY_SEEN: ReadonlySet<string> = new Set([
  'f3e21663-37ac-463b-9217-6e13793bf099', // Barfi Bliss
  '7581019a-d788-42ad-8d3e-4e6078ff70e5', // Cakes & Crumbs
  'ad086831-12fb-475e-bbdc-85b969356544', // Brownie Babe
  '54e29439-dff0-48c5-8002-9abd1247a7f3', // Bes-Teas Bubble Tea
  '589caafa-7f8c-4438-8363-94560855e74c', // Whisked By Saabirah
  '8459c95a-fdde-4869-ad2b-2c867eeb82a6', // Filigrana Authentic Peruvian Treats
  '8d48aaa6-8cc3-41e7-b52e-9d98b60c3d75', // Mestizo Taste Latino
  '38b3d32d-fadf-43bf-b58c-230f6a44a322', // Habibi
  '90878011-d366-477b-86ae-130088a7bcb4', // BlackTop Street Kitchen
  '9c0f5fe2-20cd-45de-aaf4-e612d1c4a3f7', // Dailyfresh corn (pending row)
  '6484cfa4-6875-462e-96d3-5f95a7a53829', // Dailyfresh corn
  'd3cbc49f-8eac-4fdb-9be2-db38975e1041', // Joe & Co.
  'e3a452b9-8175-401b-825d-cd1dc1cb339f', // It's SnackTime
])
