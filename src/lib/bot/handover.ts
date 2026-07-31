// Human handover state for the festival WhatsApp bot.
//
// When a user types "talk to human" / "speak to support" / "agent" / etc., the
// bot stops auto-responding to them and Samreen takes over via /admin/bot-inbox.
// Same DDL-free pattern as lib/bot/admin-chat.ts (markers stored as a body
// prefix on outbound wa_messages rows):
//
//   [HUMAN_HANDOVER_ON]   ← bot pauses for this phone, Samreen handles
//   [HUMAN_HANDOVER_OFF]  ← bot resumes auto-replies
//
// State recovery: scan recent outbound wa_messages for the user's phone and
// take the most recent ON/OFF marker. Auto-expires after 24h with no further
// exchange (resumes auto-bot).

import { createAdminClient } from '@/lib/supabase/admin'

const ON_MARKER = '[HUMAN_HANDOVER_ON]'
const OFF_MARKER = '[HUMAN_HANDOVER_OFF]'
// Set when an UNKNOWN contact asks for a human and we've asked them for their
// name + reason; their next message is captured as the handover context.
const PENDING_MARKER = '[HUMAN_HANDOVER_PENDING]'
const TTL_MS = 24 * 60 * 60 * 1000

/** Phrases that escalate the conversation to a human handler. */
const HUMAN_KEYWORDS = [
  /\btalk to (a |the )?human\b/i,
  /\bspeak to (a |the )?(human|person|agent|support|someone)\b/i,
  /\b(real|live) (person|human)\b/i,
  /^human$/i,
  /^agent$/i,
  /^support$/i,
  /\bcontact support\b/i,
  /\bhelp from a human\b/i,
  /\bsomeone to help\b/i,
  /\btalk to samreen\b/i,
]

export function detectHumanIntent(text: string): boolean {
  if (!text) return false
  return HUMAN_KEYWORDS.some((re) => re.test(text))
}

/** Persist a handover marker (ON / OFF / PENDING) for a phone. */
async function writeMarker(waPhone: string, marker: string, note: string): Promise<void> {
  const db = createAdminClient()
  await db.from('wa_messages').insert({
    direction: 'out',
    wa_phone: waPhone,
    body: `${marker} ${note}`,
    // 'logged' is NOT in the wa_messages status_check constraint (only
    // sent/read/queued/delivered/failed) — inserting it threw, so EVERY handover
    // write silently failed and Take Over never actually paused the bot. Use
    // 'sent', a permitted value. The row is a system marker (isMarker hides it).
    status: 'sent',
    provider_message_id: null,
  })
}

/** Flip the bot to OFF (human-handling) for this user. */
export async function escalateToHuman(waPhone: string, reason: string): Promise<void> {
  await writeMarker(waPhone, ON_MARKER, reason.slice(0, 200))
}

/** Release the user back to the bot. */
export async function releaseToBot(waPhone: string, note: string = 'released by admin'): Promise<void> {
  await writeMarker(waPhone, OFF_MARKER, note.slice(0, 200))
}

/** Mark that we've asked an unknown contact for their name + reason. */
export async function setPendingHandover(waPhone: string): Promise<void> {
  await writeMarker(waPhone, PENDING_MARKER, 'awaiting name + reason')
}

/**
 * Are we waiting on this phone's name + reason? True if the most recent handover
 * marker (within TTL) is PENDING — i.e. they asked for a human, we asked who
 * they are, and they haven't replied yet.
 */
export async function isPendingHandover(waPhone: string): Promise<boolean> {
  const db = createAdminClient()
  const since = new Date(Date.now() - TTL_MS).toISOString()
  const { data } = await db
    .from('wa_messages')
    .select('body, created_at')
    .eq('wa_phone', waPhone)
    .eq('direction', 'out')
    .gte('created_at', since)
    .or(`body.ilike.${PENDING_MARKER}%,body.ilike.${ON_MARKER}%,body.ilike.${OFF_MARKER}%`)
    .order('created_at', { ascending: false })
    .limit(1)
  return String(data?.[0]?.body || '').startsWith(PENDING_MARKER)
}

/**
 * Is this phone currently being handled by a human?
 *
 * True if the most recent ON marker (within TTL_MS) is more recent than the
 * most recent OFF marker.
 */
export async function isInHandover(waPhone: string): Promise<boolean> {
  const db = createAdminClient()
  const since = new Date(Date.now() - TTL_MS).toISOString()
  const { data } = await db
    .from('wa_messages')
    .select('body, created_at')
    .eq('wa_phone', waPhone)
    .eq('direction', 'out')
    .gte('created_at', since)
    .or(`body.ilike.${ON_MARKER}%,body.ilike.${OFF_MARKER}%`)
    .order('created_at', { ascending: false })
    .limit(1)
  const row = data?.[0]
  if (!row) return false
  return String(row.body).startsWith(ON_MARKER)
}
