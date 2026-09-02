/**
 * Per-vendor view scope for the festival owner.
 *
 * WHY THIS EXISTS. Y&K gifts and toys paid by EFT after the global switch
 * exposed the bank details to them. The money is real and Samreen needs the
 * vendor in her portal and her totals, but the conversation that produced it is
 * master-lane. Taona 2026-07-28: she sees everything up to the payment, then a
 * single confirmation, and nothing after.
 *
 * SO IT SCOPES A VIEW, IT DOES NOT REWRITE HISTORY. Nothing is edited and
 * nothing is deleted. The real thread stays intact underneath for the EFT admin,
 * which matters because Taona intends to correct all of this once he reconciles:
 * you cannot correct from a record that was already rewritten.
 *
 * The marker is ⟦OWNERCUT:<iso>⟧ on vendor_applications.admin_notes (DDL is
 * blocked, Law 8). For any viewer who is not the EFT admin:
 *   messages strictly BEFORE the cutoff  -> shown as normal
 *   messages at or AFTER the cutoff      -> withheld
 * and the caller substitutes one static confirmation in their place.
 *
 * DELIBERATELY TIME-BASED rather than a list of message ids. Anything Y&K sends
 * from now on lands after the cutoff and is therefore withheld automatically,
 * which is the requirement ("any further coms will show only to master lane").
 * An id list would need maintaining every time they wrote again, and the first
 * time someone forgot, a master-lane message would surface in her inbox.
 */

const OWNERCUT_RE = /⟦OWNERCUT:([^⟧]+)⟧/

/** Read the cutoff, if this vendor has one. */
export function ownerCutoff(adminNotes: string | null | undefined): string | null {
  const m = OWNERCUT_RE.exec(adminNotes || '')
  if (!m) return null
  const iso = m[1].trim()
  return Number.isNaN(Date.parse(iso)) ? null : iso
}

/** Add or replace the cutoff, leaving every other marker and all prose intact. */
export function withOwnerCutoff(adminNotes: string | null | undefined, iso: string): string {
  const base = (adminNotes || '').replace(OWNERCUT_RE, '').trim()
  return `⟦OWNERCUT:${iso}⟧${base ? ' ' + base : ''}`
}

/** Remove it. Used when Taona reconciles and hands over the real thread. */
export function withoutOwnerCutoff(adminNotes: string | null | undefined): string {
  return (adminNotes || '').replace(OWNERCUT_RE, '').replace(/\s{2,}/g, ' ').trim()
}

/**
 * Should this message be withheld from a cutoff-scoped viewer?
 *
 * At-or-after, not strictly after: the confirmation AT the cutoff is the one
 * being replaced by the static message, so it must be withheld too.
 */
export function hiddenByCutoff(messageAt: string | null | undefined, cutoff: string | null): boolean {
  if (!cutoff || !messageAt) return false
  const t = Date.parse(messageAt)
  const c = Date.parse(cutoff)
  if (Number.isNaN(t) || Number.isNaN(c)) return false   // unparseable: never hide by accident
  return t >= c
}

/**
 * Apply the cutoff to a list of messages.
 *
 * `hide` is the caller's viewer test, exactly as stripEftMessages takes it, so
 * the EFT admin passes false and sees everything.
 */
export function applyOwnerCutoff<T>(
  messages: T[] | null | undefined,
  at: (m: T) => string | null | undefined,
  cutoff: string | null,
  hide: boolean,
): T[] {
  const list = messages || []
  if (!hide || !cutoff) return list
  return list.filter((m) => !hiddenByCutoff(at(m), cutoff))
}
