/**
 * Inbox live updates via Supabase Realtime BROADCAST.
 *
 * When a WhatsApp/email message lands (or the bot replies), the server fires a
 * tiny "refresh" broadcast on the `inbox-updates` channel. The admin inbox is
 * subscribed and re-fetches instantly through the existing server route, so it
 * feels live without polling. The broadcast carries NO message content (no PII),
 * so the public channel is safe — it's just a "something changed" ping.
 *
 * Uses the Realtime HTTP broadcast endpoint (no persistent socket needed from a
 * serverless function). Best-effort: never throws into the caller.
 */
export async function broadcastInboxRefresh(reason = 'message'): Promise<void> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ topic: 'inbox-updates', event: 'refresh', payload: { reason }, private: false }],
      }),
    })
  } catch (e) {
    console.warn('[inbox-realtime] broadcast failed:', (e as Error).message)
  }
}
