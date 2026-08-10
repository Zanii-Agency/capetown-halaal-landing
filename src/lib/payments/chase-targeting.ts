// Person-level chase suppression + send de-dup.
//
// Both the payment-reminder cron and the operator chase script used to decide
// "chase this vendor?" one APPLICATION ROW at a time. A real person can hold
// more than one approved row (a re-application, a typo'd second submission).
// When they pay, only ONE row carries the paid state; the empty twin still
// reads "approved, unpaid" and got chased on the SAME phone, so a paid vendor
// received a "final notice" (Melonscape, Chocotag, 2026-08-10).
//
// The fix is to key the decision on the PERSON (phone + email union), not the
// row: if ANY of a person's rows is settled/deferred, none of their rows are
// chaseable; and a person is messaged at most once per run.
//
// is_duplicate / duplicate_of_id are NOT usable here: verified 2026-08-10 that
// both Melonscape rows and both Chocotag rows are is_duplicate=false,
// duplicate_of_id=null. Phone/email is the only reliable person key.

import { parsePortalState, isChaseSuppressed } from '@/lib/portal-state'
import { toE164 } from '@/lib/whatsapp'
import { normalizeEmail } from '@/lib/email-normalize'

export type ChaseRow = {
  email?: string | null
  phone?: string | null
  admin_notes?: string | null
  paid_at?: string | null
}

export function phoneKeyOf(phone?: string | null): string {
  try {
    return phone ? toE164(phone) : ''
  } catch {
    return ''
  }
}

export function emailKeyOf(email?: string | null): string {
  return normalizeEmail(email || '')
}

/** A row is settled for suppression purposes if its portal state says so
 *  (paid/collected/waived, or a deferral still in force) OR the DB paid_at
 *  column is set (belt and suspenders: a paid row missing the portal marker
 *  must still suppress its twin). */
function rowSettled(row: ChaseRow, now: Date): boolean {
  return isChaseSuppressed(parsePortalState(row.admin_notes || ''), now) || !!row.paid_at
}

/**
 * Build a person-level suppression index from ALL fetched rows. `has(row)`
 * returns true when the row's person is settled/deferred on ANY of their rows,
 * so the caller skips it even if this particular row looks unpaid.
 */
export function buildSuppressedPeople(rows: ChaseRow[], now: Date = new Date()) {
  const phones = new Set<string>()
  const emails = new Set<string>()
  for (const r of rows) {
    if (!rowSettled(r, now)) continue
    const pk = phoneKeyOf(r.phone)
    if (pk) phones.add(pk)
    const ek = emailKeyOf(r.email)
    if (ek) emails.add(ek)
  }
  return {
    phones,
    emails,
    has(row: ChaseRow): boolean {
      const pk = phoneKeyOf(row.phone)
      const ek = emailKeyOf(row.email)
      return (!!pk && phones.has(pk)) || (!!ek && emails.has(ek))
    },
  }
}

/**
 * Tracks who has already been messaged this run so a person with two unpaid
 * rows is not double-texted. `claim(row)` returns false if already messaged
 * (skip), true if newly claimed (send, and remembers it).
 */
export function newSendDeduper() {
  const phones = new Set<string>()
  const emails = new Set<string>()
  return {
    claim(row: ChaseRow): boolean {
      const pk = phoneKeyOf(row.phone)
      const ek = emailKeyOf(row.email)
      if ((pk && phones.has(pk)) || (ek && emails.has(ek))) return false
      if (pk) phones.add(pk)
      if (ek) emails.add(ek)
      return true
    },
  }
}
