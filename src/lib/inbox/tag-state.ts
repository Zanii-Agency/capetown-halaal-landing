/**
 * The `tag` column codec, shared by everything that writes it and everything
 * that reads it.
 *
 * DDL is blocked on this project (CTH-DOCTRINE Law 8), so the star flag has no
 * column of its own. It is pipe-encoded alongside the operational tag in the one
 * `tag` column that already exists on both vendor_tickets and
 * support_inbox_threads, e.g. "starred|payment".
 *
 * WHY IT IS ITS OWN MODULE. The encoder and decoder lived privately inside
 * /api/admin/inbox/unified/status/route.ts, so stars could be WRITTEN and never
 * READ: nothing outside that route could decode the column, and the thread
 * loaders did not try. The result was a feature that persisted correctly and was
 * invisible to every human — Taona and Samreen both starred threads and neither
 * ever saw a star. One codec, imported by both sides, is what stops the write
 * format and the read format drifting apart.
 *
 * NOTE ON SHARING: neither table has a viewer column, so a star is a property of
 * the CONVERSATION, not of the person who set it. That is exactly what Taona
 * asked for — "if i star an email she should see it starred on her side too" —
 * and it was already true in the data. It just had no reader.
 */

export const INBOX_TAGS = ['payment', 'load-in', 'badges', 'contract', 'refund', 'general'] as const
export type InboxTag = (typeof INBOX_TAGS)[number]

export interface TagState {
  starred: boolean
  tag: string | null
}

export function parseTag(v: string | null | undefined): TagState {
  const parts = (v || '').split('|').map((s) => s.trim()).filter(Boolean)
  return {
    starred: parts.includes('starred'),
    tag: parts.find((p) => p !== 'starred') || null,
  }
}

export function encodeTag(starred: boolean, tag: string | null): string | null {
  const parts = [starred ? 'starred' : null, tag].filter(Boolean) as string[]
  return parts.length ? parts.join('|') : null
}
