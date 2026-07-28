/**
 * What the PUBLIC analytics endpoint is allowed to write.
 *
 * THE HOLE THIS CLOSES. /api/analytics/track is unauthenticated by design (it is
 * called from the marketing site on every pageview) and it writes with the
 * SERVICE-ROLE client, so RLS does not apply. It validated only that `type` and
 * `session_id` were PRESENT, and then used `type` verbatim as `event_type`.
 *
 * site_events is not an analytics table. It is the project's general-purpose
 * event log, and DDL is blocked (Law 8) so privileged state lives in it too. In
 * particular `getEftMode()` (src/lib/eft.ts:194) returns the newest row where
 * event_type='eft_mode' and reads `metadata.on`. That is the SAME row shape that
 * /api/admin/eft/mode writes behind requireOperator() + isEftAdmin().
 *
 * So before this allow-list, an unauthenticated POST of
 *   {"type":"eft_mode","session_id":"x","metadata":{"on":true}}
 * became the newest eft_mode row and flipped the entire festival's payment lane:
 * every vendor shown bank details instead of Yoco, and the Samreen isolation
 * wall inverted. Posting {"on":false} was arguably worse, silently reverting a
 * lane that had been deliberately activated, with an audit trail pointing at
 * "analytics".
 *
 * Other privileged event types in the same table: eft_lane_add, chase_email,
 * chase_whatsapp, contract_signed, contract_resend, csv_export,
 * ticket_buyer_archive_*, abuse_guard_hit. None of them belong to the public.
 *
 * THE RULE: a public writer into a shared log must name what it may write. An
 * open `event_type` is an open door to every reader of that log, and the readers
 * are added later by people who have no idea the door exists.
 */

/** The only event types the public tracker may write. */
export const PUBLIC_ANALYTICS_EVENTS = new Set([
  'pageview',            // handled on its own branch, into page_views
  'zanii_click',         // the Made by Zanii attribution link
  'apply_step',          // vendor application funnel
  'apply_submit',
  'apply_success',
  'apply_email_captured',
])

/** Metadata bigger than this is not analytics, it is someone probing. */
export const MAX_METADATA_BYTES = 2048

export function isPublicAnalyticsEvent(type: unknown): type is string {
  return typeof type === 'string' && PUBLIC_ANALYTICS_EVENTS.has(type)
}

/**
 * Metadata is stored as jsonb and read by other surfaces, so bound it. Returns
 * null rather than throwing: analytics must never break a user's page.
 */
export function safeMetadata(m: unknown): Record<string, unknown> {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {}
  try {
    const s = JSON.stringify(m)
    if (s.length > MAX_METADATA_BYTES) return {}
    return m as Record<string, unknown>
  } catch {
    return {}
  }
}
