// Per-vendor notification channel preferences (WhatsApp / email) for the
// exhibitor portal. Persists server-side as a marker on the PORTAL state inside
// vendor_applications.admin_notes (CTH-DOCTRINE Law 8 — no new table, no DDL).
//
// SOURCE OF TRUTH: state.notification_preferences. The keys here are read
// VERBATIM by lib/notifications.ts `notifyVendor` via
// prefs[`${event}_${channel}`] !== false, so the toggle values actually gate
// outbound sends. Keys MUST stay in lockstep with the NotifyEvent union
// (stall_allocated | document_approved | document_rejected) × channel.
//
// Default-on semantics: a missing/true value means "send"; only an explicit
// false suppresses a channel. We therefore only need to persist the toggles a
// vendor has actually flipped, but we store the full set for a stable GET.

import { NextRequest, NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'

export const dynamic = 'force-dynamic'

// The 6 canonical pref keys, aligned 1:1 with notifyVendor's
// `${event}_${channel}` lookups. Defaults are default-on (true) EXCEPT
// document_rejected_whatsapp which mirrors the previous UI's quieter default
// for announcement-style noise; kept true here so rejections always reach the
// vendor on both channels (a rejection is action-required, never optional).
const PREF_KEYS = [
  'stall_allocated_whatsapp',
  'stall_allocated_email',
  'document_approved_whatsapp',
  'document_approved_email',
  'document_rejected_whatsapp',
  'document_rejected_email',
] as const

type PrefKey = (typeof PREF_KEYS)[number]
type Prefs = Record<PrefKey, boolean>

const DEFAULT_PREFS: Prefs = {
  stall_allocated_whatsapp: true,
  stall_allocated_email: true,
  document_approved_whatsapp: true,
  document_approved_email: true,
  document_rejected_whatsapp: true,
  document_rejected_email: true,
}

const PREF_KEY_SET = new Set<string>(PREF_KEYS)

/** Merge persisted prefs over defaults, dropping any unknown keys. */
function resolvePrefs(stored: Record<string, unknown> | undefined): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS }
  if (stored) {
    for (const k of PREF_KEYS) {
      if (typeof stored[k] === 'boolean') out[k] = stored[k] as boolean
    }
  }
  return out
}

// GET: return the signed-in vendor's saved prefs (defaults where unset).
export async function GET() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const app = ctx.application as Record<string, unknown>
  const state = parsePortalState(app.admin_notes as string)
  const prefs = resolvePrefs(state.notification_preferences as Record<string, unknown> | undefined)
  return NextResponse.json({ prefs })
}

// POST/PATCH: validate + persist the toggle values. Accepts either a single
// { key, value } flip or a full { prefs } object. Never fakes success: any
// failure throwing out of updatePortalState bubbles to a 500 and the client
// reverts its optimistic toggle.
async function save(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const applicationId = ctx.application.id as string

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Normalise into a partial map of validated key→bool.
  const incoming: Partial<Prefs> = {}
  const b = body as Record<string, unknown>

  if (b && typeof b.key === 'string' && typeof b.value === 'boolean') {
    if (!PREF_KEY_SET.has(b.key)) {
      return NextResponse.json({ error: `Unknown preference: ${b.key}` }, { status: 400 })
    }
    incoming[b.key as PrefKey] = b.value
  } else if (b && b.prefs && typeof b.prefs === 'object') {
    const p = b.prefs as Record<string, unknown>
    for (const k of Object.keys(p)) {
      if (!PREF_KEY_SET.has(k)) {
        return NextResponse.json({ error: `Unknown preference: ${k}` }, { status: 400 })
      }
      if (typeof p[k] !== 'boolean') {
        return NextResponse.json({ error: `Preference ${k} must be a boolean` }, { status: 400 })
      }
      incoming[k as PrefKey] = p[k] as boolean
    }
  } else {
    return NextResponse.json(
      { error: 'Body must be { key, value } or { prefs: {...} }' },
      { status: 400 },
    )
  }

  const next = await updatePortalState(applicationId, (s) => {
    const merged = resolvePrefs(s.notification_preferences as Record<string, unknown> | undefined)
    for (const [k, v] of Object.entries(incoming)) {
      merged[k as PrefKey] = v as boolean
    }
    return { ...s, notification_preferences: merged }
  })

  // Return the authoritative saved prefs (post-write), never a fabricated echo.
  const prefs = resolvePrefs(next.notification_preferences as Record<string, unknown> | undefined)
  return NextResponse.json({ ok: true, prefs })
}

export async function POST(req: NextRequest) {
  return save(req)
}

export async function PATCH(req: NextRequest) {
  return save(req)
}
