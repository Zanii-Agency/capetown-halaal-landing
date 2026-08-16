// Person-level chase targeting: hard suppression, extension surfacing, send de-dup.
//
// Both the payment-reminder cron and the operator chase script used to decide
// "chase this vendor?" one APPLICATION ROW at a time. A real person can hold
// more than one approved row (a re-application, a typo'd second submission).
// When they pay, only ONE row carries the paid state; the empty twin still
// reads "approved, unpaid" and got chased on the SAME phone, so a paid vendor
// received a "final notice" (Melonscape, Chocotag, 2026-08-10).
//
// The fix keys the decision on the PERSON (phone + email union), not the row:
//   - hardHas(row): the person is paid or withdrawn on ANY row -> never chase.
//   - arrangementFor(row): the person has an in-force extension on ANY row ->
//     chase GENTLY with an extension-aware body, never a final notice.
//   - newSendDeduper(): a person with two unpaid rows is messaged once.
//
// is_duplicate / duplicate_of_id are NOT usable here: verified 2026-08-10 that
// both Melonscape rows and both Chocotag rows are is_duplicate=false,
// duplicate_of_id=null. Phone/email is the only reliable person key.

import { parsePortalState, hasPaid, isWithdrawn, getArrangement } from '@/lib/portal-state'
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

/** A row hard-suppresses its person (silent, never chased) when it is paid,
 *  withdrawn, or carries a paid_at DB column even without a portal marker. */
function rowHardSettled(row: ChaseRow): boolean {
  const st = parsePortalState(row.admin_notes || '')
  return hasPaid(st) || isWithdrawn(st) || !!row.paid_at
}

/**
 * Person-level index built once from ALL fetched rows.
 *   hardHas(row)       -> person is paid/withdrawn somewhere: skip silently.
 *   arrangementFor(row)-> in-force extension {until}|null found on any row.
 */
export function buildSuppressedPeople(rows: ChaseRow[], now: Date = new Date()) {
  const hardPhones = new Set<string>()
  const hardEmails = new Set<string>()
  const arrPhones = new Map<string, { until: string | null }>()
  const arrEmails = new Map<string, { until: string | null }>()

  for (const r of rows) {
    const pk = phoneKeyOf(r.phone)
    const ek = emailKeyOf(r.email)
    if (rowHardSettled(r)) {
      if (pk) hardPhones.add(pk)
      if (ek) hardEmails.add(ek)
      continue
    }
    const arr = getArrangement(parsePortalState(r.admin_notes || ''), now)
    if (arr) {
      if (pk && !arrPhones.has(pk)) arrPhones.set(pk, arr)
      if (ek && !arrEmails.has(ek)) arrEmails.set(ek, arr)
    }
  }

  return {
    hardHas(row: ChaseRow): boolean {
      const pk = phoneKeyOf(row.phone)
      const ek = emailKeyOf(row.email)
      return (!!pk && hardPhones.has(pk)) || (!!ek && hardEmails.has(ek))
    },
    arrangementFor(row: ChaseRow): { until: string | null } | null {
      const pk = phoneKeyOf(row.phone)
      const ek = emailKeyOf(row.email)
      return (pk && arrPhones.get(pk)) || (ek && arrEmails.get(ek)) || null
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
