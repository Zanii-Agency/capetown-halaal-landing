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
