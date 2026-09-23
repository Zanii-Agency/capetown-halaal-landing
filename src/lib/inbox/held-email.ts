// A NEW email from a restricted viewer (the festival owner) to a vendor walled from
// her is HELD: it reads as sent in her UI, is never delivered to the vendor, and is
// forwarded to the master (Taona 2026-09-23). Fails closed: no provable wall = hold.
import type { LaneScope } from '@/lib/inbox-lane'

export function shouldHoldNewEmail(
  scope: Pick<LaneScope, 'unrestricted' | 'blocks'>,
  walled: { blocks: (phone?: string | null, email?: string | null) => boolean } | null,
  email: string,
  /** Every application row carrying this email (looked up server-side, never from
   *  the client). The wall is per PERSON: a twin row with a different email but the
   *  same phone as a master payer must hold too (MacSmashed, Melonscape). */
  rows: Array<{ id?: string | null; phone?: string | null }> = [],
): boolean {
  if (scope.unrestricted) return false
  if (!walled) return true
  if (scope.blocks({ email }) || walled.blocks(null, email)) return true
  return rows.some((r) => scope.blocks({ email, phone: r.phone ?? null, applicationId: r.id ?? null }) || walled.blocks(r.phone ?? null, email))
}

/** One master alert per held blast (never one per vendor): who wrote it, which
 *  tool, how many were held and who, and what it said. Best-effort. */
export async function notifyHeldBlast(opts: {
  viewer: string | null | undefined
  tool: 'broadcast' | 'chase' | 'campaign'
  names: string[]
  channel: string
  subject?: string | null
  preview?: string | null
}): Promise<void> {
  if (!opts.names.length) return
  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    const list = opts.names.slice(0, 40).join(', ') + (opts.names.length > 40 ? ` and ${opts.names.length - 40} more` : '')
    await notifyOwners({
      event: 'system_alert',
      audience: 'master',
      body: `HELD ${opts.tool.toUpperCase()} (not delivered): ${opts.viewer || 'the owner'} sent a ${opts.channel} ${opts.tool}; ${opts.names.length} master-lane vendor(s) were held and did not receive it: ${list}.${opts.subject ? `\nSubject: ${opts.subject}` : ''}${opts.preview ? `\n\n${String(opts.preview).slice(0, 800)}` : ''}`,
    })
  } catch (e) { console.error('[held-blast] master notify failed:', (e as Error).message) }
}
