// WhatsApp consent gate — the single chokepoint every outbound message passes
// through. This is what keeps the festival number (and therefore the host WABA,
// Nisria now / Halaal Hub later) safe: no record → no send; STOP → never again.
//
// Rules enforced by canSend():
//   - opted_out          → BLOCK everything, forever (hard stop, even utility)
//   - marketing category → require explicit opted_in === true
//   - utility/auth/service → allowed unless opted_out (transactional consent)
//   - free-form text     → only inside the 24h service window AND not opted_out

import { createAdminClient } from '@/lib/supabase/admin'
import { isAdmin } from '@/lib/bot/admins'

export type WaCategory = 'utility' | 'marketing' | 'authentication' | 'service'
export type ConsentSource = 'checkout' | 'vendor_form' | 'inbound' | 'manual' | 'import'

// wa_v2 = T&C-based auto opt-in. By buying a ticket or submitting a vendor
// application (and accepting the Terms & Conditions), the person agrees to
// receive Young at Heart Festival event updates and communications via WhatsApp
// and email. STOP always works and is honoured forever (see recordOptOut).
export const CONSENT_TEXT_VERSION = 'wa_v2'
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

interface ContactState {
  opted_in: boolean
  opted_out: boolean
  is_buyer: boolean
  last_inbound_at: string | null
}

// CONTACT MEMO (efficiency, 2026-06-12). One inbound turn was paying the same
// wa_contacts lookup up to three times: canSend for the reply, canSend for the
// master notify, and the admin branch's double call. A 5 second TTL memo
// inside the warm instance absorbs the repeats within a turn while staying
// far too short to mask a real consent change — and every writer below
// (recordConsent, recordOptOut, touchInbound) invalidates the entry anyway,
// so a STOP takes effect on the very next read.
const contactMemo = new Map<string, { c: ContactState | null; at: number }>()
const CONTACT_MEMO_TTL_MS = 5000

function invalidateContactMemo(waPhone: string): void {
  contactMemo.delete(waPhone)
}

async function getContact(waPhone: string): Promise<ContactState | null> {
  const hit = contactMemo.get(waPhone)
  if (hit && Date.now() - hit.at < CONTACT_MEMO_TTL_MS) return hit.c
  const db = createAdminClient()
  const { data } = await db
    .from('wa_contacts')
    .select('opted_in, opted_out, is_buyer, last_inbound_at')
    .eq('wa_phone', waPhone)
    .maybeSingle()
  const c = (data as ContactState) ?? null
  contactMemo.set(waPhone, { c, at: Date.now() })
  return c
}

export interface SendDecision {
  allowed: boolean
  reason: string
}

// THE GATE. Call before every outbound message.
export async function canSend(
  waPhone: string,
  kind: { type: 'template'; category: WaCategory } | { type: 'text' }
): Promise<SendDecision> {
  // Bot admins (Taona, Samreen) are not subject to marketing/window gates —
  // they're internal users, not customers. STOP still applies (explicit opt-out
  // is honoured for everyone) but they cannot be silently blocked from
  // utility/marketing/free-form just because the customer consent table doesn't
  // know about them.
  if (isAdmin(waPhone)) {
    const c = await getContact(waPhone)
    if (c?.opted_out) return { allowed: false, reason: 'admin contact opted out (STOP)' }
    return { allowed: true, reason: 'admin bypass' }
  }

  const c = await getContact(waPhone)

  // Unknown contact: never opted out, but also never opted in.
  if (c?.opted_out) return { allowed: false, reason: 'contact opted out (STOP)' }

  if (kind.type === 'text') {
    // Free-form only allowed inside the 24h service window.
    const last = c?.last_inbound_at ? Date.parse(c.last_inbound_at) : 0
    const open = last > 0 && Date.now() - last < SERVICE_WINDOW_MS
    return open
      ? { allowed: true, reason: 'within 24h service window' }
      : { allowed: false, reason: 'outside 24h window, use an approved template' }
  }

  // Template path.
  if (kind.category === 'marketing') {
    return c?.opted_in
      ? { allowed: true, reason: 'marketing opt-in on file' }
      : { allowed: false, reason: 'no marketing opt-in' }
  }
  // utility / authentication / service templates: transactional, allowed unless opted out.
  return { allowed: true, reason: `${kind.category} template (transactional)` }
}

// Record an explicit opt-in (checkout checkbox, vendor form, etc.).
// Writes BOTH the fast state (wa_contacts) and the append-only proof (wa_consent_log).
export async function recordConsent(args: {
  waPhone: string
  source: ConsentSource
  orderId?: string
  ip?: string
  userAgent?: string
  isBuyer?: boolean
  profileName?: string
}): Promise<void> {
  invalidateContactMemo(args.waPhone)
  const db = createAdminClient()
  const now = new Date().toISOString()

  await db.from('wa_contacts').upsert(
    {
      wa_phone: args.waPhone,
      opted_in: true,
      opted_out: false, // a fresh opt-in clears a prior opt-out
      opted_in_at: now,
      ...(args.isBuyer ? { is_buyer: true } : {}),
      ...(args.profileName ? { profile_name: args.profileName } : {}),
      updated_at: now,
    },
    { onConflict: 'wa_phone' }
  )

  await db.from('wa_consent_log').insert({
    wa_phone: args.waPhone,
    action: 'opt_in',
    source: args.source,
    consent_text_ver: CONSENT_TEXT_VERSION,
    order_id: args.orderId ?? null,
    ip_address: args.ip ?? null,
    user_agent: args.userAgent ?? null,
  })
}

// Record an opt-out (STOP keyword, or manual). Hard block from here on.
export async function recordOptOut(args: {
  waPhone: string
  source: ConsentSource
}): Promise<void> {
  invalidateContactMemo(args.waPhone)
  const db = createAdminClient()
  const now = new Date().toISOString()

  await db.from('wa_contacts').upsert(
    {
      wa_phone: args.waPhone,
      opted_out: true,
      opted_in: false,
      opted_out_at: now,
      updated_at: now,
    },
    { onConflict: 'wa_phone' }
  )

  await db.from('wa_consent_log').insert({
    wa_phone: args.waPhone,
    action: 'opt_out',
    source: args.source,
  })
}

// Inbound message arrived → open/refresh the 24h service window.
export async function touchInbound(waPhone: string, profileName?: string): Promise<void> {
  invalidateContactMemo(waPhone)
  const db = createAdminClient()
  const now = new Date().toISOString()
  await db.from('wa_contacts').upsert(
    {
      wa_phone: waPhone,
      last_inbound_at: now,
      ...(profileName ? { profile_name: profileName } : {}),
      updated_at: now,
    },
    { onConflict: 'wa_phone' }
  )
}

// --- STOP / START keyword detection ---
// Compliance: WhatsApp requires we honor STOP as a word in the message, not just
// as the entire trimmed body. "STOP.", "stop please", "I want to stop" all opt out.
// Word-boundary regex so accidental substrings ("stopwatch") don't trigger.
// stop/unsubscribe/optout/opt-out are unambiguous opt-out intents: match anywhere.
const STOP_RE = /\b(stop|unsubscribe|optout|opt[\s\-]?out)\b/i
// cancel/end/quit are ambiguous mid-sentence ("can I cancel my stall?",
// "when does the festival end?"), so they only opt out as the WHOLE trimmed body.
const STOP_COMMAND_RE = /^(cancel|end|quit)$/i
const START_RE = /\b(start|unstop|subscribe|optin|opt[\s\-]?in|yes)\b/i

function isStopText(t: string): boolean {
  return STOP_RE.test(t) || STOP_COMMAND_RE.test(t)
}

export function isStopKeyword(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  return isStopText(t)
}
export function isStartKeyword(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  // Guard: don't let an inbound that contains BOTH "start" and "stop" be treated as start.
  if (isStopText(t)) return false
  return START_RE.test(t)
}
