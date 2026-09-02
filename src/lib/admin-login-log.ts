// Where an admin signs in from.
//
// Taona 2026-07-28: "make a way for me to see when she logs in she uses a
// capetown ip address I need to know". Nothing recorded this: admin auth is
// client-side supabase.auth.signInWithPassword, so no server ever saw the
// request, and Supabase's own auth log is not reachable from the app.
//
// Pure helpers here; the route does the I/O. Split so the alert rule is
// testable without Supabase, WhatsApp or a live request.

/** What we keep about a sign-in. No password, no token, no session id. */
export interface LoginFacts {
  ip: string | null
  city: string | null
  region: string | null
  country: string | null
}

/** The client IP, from the proxy chain. `x-forwarded-for` is a comma-separated
 *  list appended to by each hop, so the ORIGINAL client is the FIRST entry, not
 *  the last: taking the last gives Vercel's own edge address for every user,
 *  which would make every login look identical and the whole log useless. */
export function clientIp(h: { get(name: string): string | null }): string | null {
  const fwd = h.get('x-forwarded-for')
  const first = fwd?.split(',')[0]?.trim()
  return first || h.get('x-real-ip')?.trim() || null
}

/** Vercel resolves geo at the edge, so no third-party lookup and no extra
 *  round trip. City arrives percent-encoded ("Cape%20Town"). */
export function loginFacts(h: { get(name: string): string | null }): LoginFacts {
  const raw = h.get('x-vercel-ip-city')
  let city: string | null = null
  if (raw) {
    // A malformed percent-escape makes decodeURIComponent throw, and a throw
    // here would lose the whole login record over a cosmetic field.
    try { city = decodeURIComponent(raw) } catch { city = raw }
  }
  return {
    ip: clientIp(h),
    city,
    region: h.get('x-vercel-ip-country-region'),
    country: h.get('x-vercel-ip-country') || h.get('cf-ipcountry'),
  }
}

/** Human-readable place, for the alert body and the activity row. */
export function placeLabel(f: LoginFacts): string {
  const parts = [f.city, f.country].filter(Boolean)
  return parts.length ? parts.join(', ') : 'an unknown location'
}

/** Cape Town is where the festival owner works, so a login from there is the
 *  expected case and must NOT buzz the master daily. Region code for the
 *  Western Cape is 'WC'; we accept the city name too because Vercel's region
 *  code is occasionally absent on mobile networks. */
export function isExpectedPlace(f: LoginFacts): boolean {
  if (f.country !== 'ZA') return false
  return f.region === 'WC' || (f.city || '').trim().toLowerCase() === 'cape town'
}

/** Alert the master when a sign-in is worth a look: anywhere outside Cape Town,
 *  or a first-ever IP for that admin.
 *
 *  Deliberately NOT "alert on every login". She signs in most days, and an
 *  alert that fires daily is one he stops reading, which is the same as no
 *  alert at all. The full log stays on the activity page for when he wants it. */
export function shouldAlert(f: LoginFacts, ipSeenBefore: boolean): boolean {
  return !isExpectedPlace(f) || !ipSeenBefore
}

export function alertBody(who: string, f: LoginFacts, firstTime: boolean): string {
  const where = placeLabel(f)
  const why = firstTime ? 'a new IP for them' : 'outside Cape Town'
  return `${who} just signed in to the admin portal from ${where} (${f.ip || 'IP unknown'}), ${why}.`
}
