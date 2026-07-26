// Duplicate applications, merged without DDL.
//
// A vendor who applied twice ends up with two vendor_applications rows sharing
// an email. That is not cosmetic: every lookup that resolves a person by email
// or phone then finds two rows and refuses to act. On 2026-07-26 a fully paid,
// approved vendor (A&H Homeware) messaged WhatsApp and was told the bot could
// not verify them, because vendor-session.ts hit `email_multiple`. They were
// asked to prove a payment we had already banked.
//
// The rule (Taona 2026-07-26): "merge all duplicates that are approved, but the
// approved one becomes main contact details and duplicate becomes sub and we
// never use it."
//
// The APPROVED application is the primary. Every other row in the cluster gets
// a ⟦MERGED:<primary-id>⟧ marker on admin_notes and is skipped by every lookup.
// Marker on admin_notes rather than a column because DDL is blocked on this
// Supabase project (Doctrine Law 8) — same pattern as ⟦EFT⟧, ⟦STALL:..⟧,
// ⟦NOEFT⟧ and ⟦WAV..⟧.
//
// The row is NOT deleted. A merged application is recoverable, and it is still
// the evidence that this person applied twice.

const MERGED_RE = /⟦MERGED:([0-9a-fA-F-]{36})⟧/

/** The primary application this row was merged into, or null if it is not merged. */
export function mergedInto(adminNotes: string | null | undefined): string | null {
  const m = MERGED_RE.exec(adminNotes || '')
  return m ? m[1] : null
}

/** True when this row is a subordinate duplicate and must be ignored. */
export function isMerged(adminNotes: string | null | undefined): boolean {
  return mergedInto(adminNotes) !== null
}

/** Mark a row as merged into `primaryId`. Idempotent, and never disturbs the
 *  other markers or the human prose sharing this column. */
export function withMergedMarker(adminNotes: string | null | undefined, primaryId: string): string {
  const base = withoutMergedMarker(adminNotes)
  const marker = `⟦MERGED:${primaryId}⟧`
  return base ? `${base}\n\n${marker}` : marker
}

/** Un-merge: strip the marker, leaving everything else intact. */
export function withoutMergedMarker(adminNotes: string | null | undefined): string {
  return (adminNotes || '').replace(MERGED_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** Normalised email key. THE root cause of these duplicates: six of the seven
 *  live clusters differ only by capitalisation (`Israarahman91@` vs
 *  `israarahman91@`), which is the same mailbox to every mail server on earth
 *  but two distinct rows here. Use this everywhere an email is compared or
 *  stored, never a raw string compare. */
export function emailKey(email: string | null | undefined): string {
  return String(email || '').trim().toLowerCase()
}

/** Drop merged subordinates from any set of application rows. The one-liner
 *  every lookup needs, so "skip merged" cannot be forgotten at one call site
 *  the way the EFT lane check was. */
export function withoutMerged<T extends { admin_notes?: string | null }>(rows: T[] | null | undefined): T[] {
  return (rows || []).filter((r) => !isMerged(r.admin_notes))
}
