/**
 * Abuse guard for public-write endpoints (vendor apply, lead capture).
 * Shared between /api/applications and /api/analytics/capture-email.
 *
 * Defense layers:
 *   1. Honeypot     -> bots fill hidden fields, humans never see them.
 *   2. Reserved TLD -> .test/.invalid/.example/.localhost never resolve.
 *   3. Disposable   -> known throwaway providers (mailinator etc).
 *   4. Tokens       -> obvious scanner payloads (PWNED, <script, audit2-...).
 *   5. IP throttle  -> caller-side rate limit using existing site_events.
 *
 * Cloudflare WAF + Bot Fight Mode are the primary shield. This file is the
 * application-layer fallback so a single Cloudflare misconfig does not open
 * the door.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const HONEYPOT_FIELD = 'company_website_url'

const RESERVED_TLDS = new Set([
  'test', 'invalid', 'example', 'localhost', 'local', 'internal',
])

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'tempmail.com', '10minutemail.com', 'guerrillamail.com',
  'throwawaymail.com', 'yopmail.com', 'sharklasers.com', 'getnada.com',
  'maildrop.cc', 'temp-mail.org', 'fakeinbox.com', 'trashmail.com',
  'dispostable.com', 'mailnesia.com', 'spambog.com', 'emailondeck.com',
])

const ATTACKER_TOKEN_PATTERNS: RegExp[] = [
  /\bpwned\b/i,
  /\battacker\b/i,
  /<script\b/i,
  /javascript:/i,
  /\bonerror\s*=/i,
  /\bonload\s*=/i,
  /\bunion\s+select\b/i,
  /\bdrop\s+table\b/i,
  /\bxss\b/i,
  /\baudit\d+-\d{8,}\b/i,
  /\$\{.*\}/,
  /\{\{.*\}\}/,
  /\.\.\/\.\.\//,
]

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i

export type GuardReason =
  | 'honeypot'
  | 'email_format'
  | 'reserved_tld'
  | 'disposable'
  | 'attacker_token'
  | 'rate_limited'

export interface GuardResult {
  ok: boolean
  reason?: GuardReason
}

export function checkHoneypot(payload: Record<string, unknown>): GuardResult {
  const val = payload[HONEYPOT_FIELD]
  if (typeof val === 'string' && val.trim().length > 0) {
    return { ok: false, reason: 'honeypot' }
  }
  return { ok: true }
}

export function checkEmail(email: string): GuardResult {
  const trimmed = email.trim().toLowerCase()
  if (!EMAIL_RE.test(trimmed)) return { ok: false, reason: 'email_format' }
  const [, domain] = trimmed.split('@')
  if (!domain) return { ok: false, reason: 'email_format' }
  const tld = domain.split('.').pop() ?? ''
  if (RESERVED_TLDS.has(tld)) return { ok: false, reason: 'reserved_tld' }
  if (DISPOSABLE_DOMAINS.has(domain)) return { ok: false, reason: 'disposable' }
  return { ok: true }
}

export function checkTokens(...values: Array<string | null | undefined>): GuardResult {
  for (const v of values) {
    if (!v) continue
    for (const pat of ATTACKER_TOKEN_PATTERNS) {
      if (pat.test(v)) return { ok: false, reason: 'attacker_token' }
    }
  }
  return { ok: true }
}

/**
 * Best-effort IP throttle using the existing site_events table.
 * Threshold default: 5 hits per IP per 10 minutes per endpoint.
 * Failures (DB blip, missing IP) fall open with ok:true so we do not
 * 500 real applicants.
 */
export async function checkIpThrottle(
  supabase: SupabaseClient,
  opts: { ip?: string; endpoint: string; max?: number; windowMin?: number },
): Promise<GuardResult> {
  const ip = opts.ip?.trim()
  if (!ip) return { ok: true }
  const max = opts.max ?? 5
  const windowMin = opts.windowMin ?? 10
  const since = new Date(Date.now() - windowMin * 60 * 1000).toISOString()
  try {
    const { count } = await supabase
      .from('site_events')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', `abuse_guard_hit:${opts.endpoint}`)
      .gte('created_at', since)
      .contains('metadata', { ip })
    if ((count ?? 0) >= max) return { ok: false, reason: 'rate_limited' }
  } catch {
    return { ok: true }
  }
  return { ok: true }
}

/**
 * Log a guard event for audit and to power the IP throttle.
 * Best-effort, never throws.
 */
export async function logGuardEvent(
  supabase: SupabaseClient,
  opts: {
    endpoint: string
    ip?: string
    reason: GuardReason
    fields?: Record<string, unknown>
  },
): Promise<void> {
  try {
    await supabase.from('site_events').insert({
      session_id: 'abuse_guard',
      event_type: `abuse_guard_hit:${opts.endpoint}`,
      path: opts.endpoint,
      metadata: {
        ip: opts.ip ?? null,
        reason: opts.reason,
        ...(opts.fields ?? {}),
      },
    })
  } catch {
    // intentionally silent
  }
}

export function clientIp(headers: Headers): string | undefined {
  // Trust EDGE-set headers first (Cloudflare / Vercel). `x-forwarded-for` is
  // client-forgeable end-to-end: an attacker sends `X-Forwarded-For: <random>`
  // per request to mint a fresh throttle key and bypass login brute-force /
  // reset-bomb limits. So XFF is the LAST resort, used only when no trusted edge
  // header is present (e.g. local dev). (Audit MED-1)
  const trusted =
    headers.get('cf-connecting-ip')?.trim() ||
    headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip')?.trim()
  if (trusted) return trusted
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined
}
