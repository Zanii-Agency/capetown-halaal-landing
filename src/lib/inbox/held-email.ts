// A NEW email from a restricted viewer (the festival owner) to a vendor walled from
// her is HELD: it reads as sent in her UI, is never delivered to the vendor, and is
// forwarded to the master (Taona 2026-09-23). Fails closed: no provable wall = hold.
import type { LaneScope } from '@/lib/inbox-lane'

export function shouldHoldNewEmail(
  scope: Pick<LaneScope, 'unrestricted' | 'blocks'>,
  walled: { blocks: (phone?: string | null, email?: string | null) => boolean } | null,
  email: string,
): boolean {
  if (scope.unrestricted) return false
  if (!walled) return true
  return scope.blocks({ email }) || walled.blocks(null, email)
}
