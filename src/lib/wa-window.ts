// Is WhatsApp's 24h customer service window open for this number?
//
// Free-form text is only deliverable inside that window. Outside it Meta
// returns a "Re-engagement message" error, and an approved template is the only
// way through.
//
// WHY THIS EXISTS SEPARATELY FROM canSend()
//
// wa-consent's canSend() short-circuits admins with an 'admin bypass' before it
// ever looks at the window, so it answers ALLOWED for an admin whose window has
// been shut for weeks. That is right for its job (consent), and useless for
// this one (deliverability). Asking it "can I send free text?" for an admin
// gets you a yes that Meta will not honour.
//
// That exact confusion cost the festival owner her alerts on 2026-07-28: her
// last inbound was 38 days old, notify tried free text first on canSend's word,
// Meta accepted it with a 200 and failed it later by webhook, so the template
// fallback never ran and 87% of a month's alerts went nowhere.
//
// Source of truth is wa_messages inbound, NOT wa_contacts.last_inbound_at:
// there is no wa_contacts row at all for the master's number, so that column
// reads null for the very people this decides for.

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

/** Pure: does this last-inbound timestamp leave the window open right now?
 *
 *  Fails CLOSED on null/unparseable. Unknown must mean "use a template": a
 *  wrong `true` produces a message Meta silently drops, a wrong `false` only
 *  costs us a template send that works either way. */
export function isWindowOpen(lastInboundAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastInboundAt) return false
  const t = new Date(lastInboundAt).getTime()
  if (!Number.isFinite(t)) return false
  return now - t < SERVICE_WINDOW_MS
}

/** Hours until the window shuts, or null when it is already closed. Used to
 *  warn the master before he loses free-text delivery. */
export function hoursUntilClose(lastInboundAt: string | null | undefined, now: number = Date.now()): number | null {
  if (!lastInboundAt || !isWindowOpen(lastInboundAt, now)) return null
  const t = new Date(lastInboundAt).getTime()
  return (SERVICE_WINDOW_MS - (now - t)) / 3_600_000
}

/** The real last inbound for a number. Best-effort: a query failure returns
 *  null, which fails closed to the template path. */
export async function lastInboundAt(e164: string): Promise<string | null> {
  try {
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const { data } = await createAdminClient()
      .from('wa_messages')
      .select('created_at')
      .eq('direction', 'in')
      .eq('wa_phone', e164)
      .order('created_at', { ascending: false })
      .limit(1)
    return (data?.[0] as { created_at?: string } | undefined)?.created_at ?? null
  } catch {
    return null
  }
}

export async function windowOpenFor(e164: string): Promise<boolean> {
  return isWindowOpen(await lastInboundAt(e164))
}
