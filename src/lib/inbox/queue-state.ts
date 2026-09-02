/**
 * "I've dealt with this." The operator's own answer to the queue.
 *
 * Taona, 2026-07-27: a thread stays pinned "until resolved", and the unpin is
 * MANUAL — "you mark it done". Until now `needs_response` was purely derived,
 * and the only thing that cleared it was an outbound row carrying
 * metadata.sent_by. Measured: 28 of 1,879 outbound WhatsApp messages have one,
 * and 18 of 204 threads have EVER had one. So the queue was a one-way door:
 * things went in and essentially nothing came out, which is why ~77% of the list
 * was pinned and the pin meant nothing.
 *
 * WHERE THE STATE LIVES. DDL is blocked on this project (Law 8) and
 * vendor_tickets can only be keyed by vendor_application_id or
 * ticket_buyer_email — it has no phone column, so a WhatsApp thread on an
 * unresolved number could not be marked at all. site_events can hold anything
 * and is already used exactly this way for the EFT mode toggle, so the marker
 * goes there, keyed by the thread id the list already uses.
 *
 * A NEW MESSAGE REOPENS IT. Done is stamped with a time, and the loader only
 * honours it while it is NEWER than the vendor's last inbound. Marking a
 * conversation done must not mute that person forever.
 */

import { createAdminClient } from '@/lib/supabase/admin'

const EVENT = 'inbox_thread_done'

export interface DoneMark {
  at: string
  by: string | null
  done: boolean
}

/** Latest done-mark per thread id. One query for the whole list. */
export async function loadDoneMarks(): Promise<Map<string, DoneMark>> {
  const marks = new Map<string, DoneMark>()
  try {
    const { data } = await createAdminClient()
      .from('site_events')
      .select('created_at, metadata')
      .eq('event_type', EVENT)
      .order('created_at', { ascending: false })
      .limit(2000)
    // DESC, so the first row seen per key is the latest and wins.
    for (const r of (data || []) as Array<{ created_at: string; metadata: Record<string, unknown> | null }>) {
      const key = String(r.metadata?.key || '')
      if (!key || marks.has(key)) continue
      marks.set(key, {
        at: String(r.metadata?.at || r.created_at),
        by: (r.metadata?.by as string) ?? null,
        done: r.metadata?.done !== false,
      })
    }
  } catch (e) {
    // Fail OPEN: a queue that cannot read its own marks should show MORE work,
    // never silently hide a waiting vendor.
    console.error('[inbox-queue] could not load done marks:', (e as Error).message)
  }
  return marks
}

/** Mark a thread done, or reopen it. */
export async function setThreadDone(threadId: string, done: boolean, by: string | null): Promise<void> {
  await createAdminClient().from('site_events').insert({
    session_id: 'inbox-queue',
    event_type: EVENT,
    path: '/admin/inbox',
    metadata: { key: threadId, done, by, at: new Date().toISOString() },
  })
}

/**
 * Is this thread cleared? Only while the mark is NEWER than their last message,
 * so a fresh inbound puts it straight back in the queue.
 */
export function isCleared(mark: DoneMark | undefined, lastInboundAt: string | null | undefined): boolean {
  if (!mark || !mark.done) return false
  if (!lastInboundAt) return true
  return new Date(mark.at).getTime() >= new Date(lastInboundAt).getTime()
}
