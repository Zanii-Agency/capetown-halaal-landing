// Inbox time + name formatting, in ONE place.
//
// Lifted verbatim from CustomerInboxClient on 2026-07-26, where they were local
// functions that NeedsYouClient had separately reimplemented — with a different
// `fmtTime` (toLocaleTimeString vs Intl.formatToParts) and its own `initials`.
// Two surfaces formatting the same timestamp two ways is exactly the kind of
// drift that reads to an operator as "out of sync".
//
// SAST = Africa/Johannesburg (UTC+2, no DST). The operator wants the real
// time-of-occurrence in SA local time, not relative "10h ago" strings. The
// timeZone is pinned on every formatter so it reads the same regardless of
// where the server or the operator's browser sits.

const SA_TZ = 'Africa/Johannesburg'

export function saParts(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  // en-GB + the SA tz gives 24h HH:mm and a day/month/year we can read back.
  // (hour12:false with en-GB renders SA midnight as "00:05", not the "24:05"
  // ICU artifact some locales produce.)
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: SA_TZ, year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t: string) => p.find((x) => x.type === t)?.value || ''
  return { day: get('day'), month: get('month'), year: get('year'), hour: get('hour'), minute: get('minute') }
}

/** Bubble timestamp: always the real SAST clock time, e.g. "14:32". */
export function fmtTime(iso: string): string {
  const p = saParts(iso)
  return p ? `${p.hour}:${p.minute}` : ''
}

/** Date separators, in SAST. Today / Yesterday relative to the SA local day. */
export function fmtDay(iso: string): string {
  const p = saParts(iso)
  if (!p) return ''
  const todayP = saParts(new Date().toISOString())
  const yP = saParts(new Date(Date.now() - 86_400_000).toISOString())
  const same = (a: typeof p, b: typeof p | null) =>
    !!b && a.day === b.day && a.month === b.month && a.year === b.year
  if (same(p, todayP)) return 'Today'
  if (same(p, yP)) return 'Yesterday'
  return `${p.day} ${p.month} ${p.year}`
}

/** Conversation-list time: the real SAST time of occurrence, compact.
 *  "14:32" when it happened today (SA), else "21 Jun 14:32". */
export function fmtSAST(iso: string | null): string {
  if (!iso) return ''
  const p = saParts(iso)
  if (!p) return ''
  const todayP = saParts(new Date().toISOString())
  const isToday = !!todayP && p.day === todayP.day && p.month === todayP.month && p.year === todayP.year
  return isToday ? `${p.hour}:${p.minute}` : `${p.day} ${p.month} ${p.hour}:${p.minute}`
}

/** Avatar initials: first + last for a full name, else the first two letters. */
export function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean)
  if (!p.length) return '?'
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase()
  return (p[0][0] + p[p.length - 1][0]).toUpperCase()
}
