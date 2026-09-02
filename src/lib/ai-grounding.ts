/**
 * What a drafter is allowed to state, and the check that makes "only this" true.
 *
 * 2026-07-27, drafted to a vendor who asked where her application stood: "Our
 * application review process concludes on 1 June 2026, when all applicants
 * receive a personal email with their outcome. Since we're still within the
 * review period, your status email is on its way." There is no 1 June deadline,
 * there is no such review process, and the date was already two months in the
 * past when it was written. The drafter's prompt carried no festival facts and no
 * notion of today, so a vendor asking for a date got one assembled from training
 * data and stated as policy.
 *
 * TWO HALVES, BOTH REQUIRED.
 *
 * The prompt side is FESTIVAL_FACTS plus SPECIFICS_RULE, which names the only two
 * places a specific may come from. It is written as a permission rather than a
 * prohibition on purpose: "Do not invent facts, prices, or commitments you were
 * not given" was ALREADY in that drafter's prompt when it wrote the sentence
 * above. A model with no grounded date and a vendor asking for one produces a
 * date, because to it the unhelpful answer is the bigger failure.
 *
 * So the second half is arithmetic, not persuasion. Every date in the draft is
 * matched against the dates in the prompt that produced it, and a date found in
 * neither the facts block nor the vendor's own message loses its sentence.
 *
 * WHY THE SENTENCE AND NOT THE WHOLE REPLY. The sibling banking guard swaps the
 * entire reply, because banking is a TOPIC the bot must not be on. A date is not
 * a topic, it is one claim inside an otherwise correct answer, and discarding a
 * good four-paragraph reply over one guessed clause just moves the work to the
 * operator. Blanking the token instead ("concludes on [removed]") would be worse
 * than either: it reads as though a real date exists and was withheld.
 */

/** The specifics both drafters are allowed to state without asking anyone. */
export const FESTIVAL_FACTS = `FESTIVAL FACTS (use only these, never invent):
- Young at Heart Festival (Cape Town Halaal), 11 to 13 December 2026, Youngsfield Military Base, Wetton Road, Claremont, Cape Town.
- Tickets R30/day, R60 weekend pass, children under 3 free. Buy + apply at cthalaal.co.za. Vendor apply: cthalaal.co.za/apply. Exhibitor portal: cthalaal.co.za/exhibitor/login.
- All food on site is strictly halaal. Free parking on site. Contact: support@youngatheart.co.za.`

/** Positive form: what MAY be stated, and what to do everywhere else. */
export const SPECIFICS_RULE = `SPECIFICS YOU MAY STATE: a date, a deadline, a price, or a step in the process belongs in your reply only when it is written in the facts above or in the message you are answering. Those two blocks are the whole of what you know. Anywhere else, say plainly that you do not want to give them a date or figure that turns out to be wrong, that you will confirm it with the team, and offer to have someone come back to them directly. Never estimate a date, never round a figure, never work a deadline out from context: a specific you were not given is a guess, and a guess sent to a vendor is read as a promise.`

/** Replaces the sentence that guessed. Deliberately carries no date of its own. */
export const DATE_DEFER_LINE =
  'I do not want to give you a date that turns out to be wrong, so let me confirm that with the team and come back to you on it.'

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
}

const M = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const ORD = '(?:st|nd|rd|th)?'
const YEAR = '((?:19|20)\\d{2})'

interface DateMention {
  raw: string
  /** Grounded if ANY of these appears in the prompt. Ambiguous formats carry both readings. */
  keys: string[]
  months: number[]
  year: string | null
}

type Read = (m: RegExpExecArray) => Omit<DateMention, 'raw'> | null

const dayKey = (mo: number, d: number) => `d${mo}-${d}`
const monthKey = (mo: number) => `m${mo}`

function month(word: string): number | null {
  return MONTHS[word.toLowerCase()] ?? null
}

function day(mo: number | null, d: number, year: string | null): Omit<DateMention, 'raw'> | null {
  if (!mo || d < 1 || d > 31) return null
  return { keys: [dayKey(mo, d)], months: [mo], year }
}

// Order matters: the widest reading of a span claims it first, so "1 June 2026"
// is one day-precision mention and not a bare "June 2026" with a stray 1.
const PATTERNS: Array<{ re: RegExp; read: Read }> = [
  { re: /\b((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})\b/g, read: (m) => day(+m[2] <= 12 ? +m[2] : null, +m[3], m[1]) },
  {
    // SA writes day first, but a drafter quoting a US-shaped date is still a
    // date: accept either reading rather than let the ambiguity smuggle one through.
    re: /\b(\d{1,2})\/(\d{1,2})\/((?:19|20)?\d{2})\b/g,
    read: (m) => {
      const [a, b] = [+m[1], +m[2]]
      const year = m[3].length === 4 ? m[3] : null
      const dm = day(b <= 12 ? b : null, a, year)
      const md = day(a <= 12 ? a : null, b, year)
      if (!dm && !md) return null
      return {
        keys: [...(dm?.keys ?? []), ...(md?.keys ?? [])],
        months: [...(dm?.months ?? []), ...(md?.months ?? [])],
        year,
      }
    },
  },
  { re: new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${M}\\b(?:,?\\s*${YEAR})?`, 'gi'), read: (m) => day(month(m[2]), +m[1], m[3] ?? null) },
  { re: new RegExp(`\\b${M}\\s+(\\d{1,2})${ORD}\\b(?:,?\\s*${YEAR})?`, 'gi'), read: (m) => day(month(m[1]), +m[2], m[3] ?? null) },
  {
    re: new RegExp(`\\b${M}\\s+${YEAR}\\b`, 'gi'),
    read: (m) => {
      const mo = month(m[1])
      return mo ? { keys: [monthKey(mo)], months: [mo], year: m[2] } : null
    },
  },
  {
    // A bare month name only counts after a temporal preposition. "may" and
    // "march" are ordinary English words, and "it may take a few days" is not a
    // deadline claim.
    re: new RegExp(`\\b(?:in|by|from|until|till|before|after|during|throughout|early|mid|late|end of|start of|beginning of)\\s+${M}\\b`, 'gi'),
    read: (m) => {
      const mo = month(m[1])
      return mo ? { keys: [monthKey(mo)], months: [mo], year: null } : null
    },
  },
]

function findDates(text: string): DateMention[] {
  const found: DateMention[] = []
  const claimed: Array<[number, number]> = []
  for (const { re, read } of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const [start, end] = [m.index, m.index + m[0].length]
      if (claimed.some(([s, e]) => start < e && end > s)) continue
      const parsed = read(m)
      if (!parsed) continue
      claimed.push([start, end])
      found.push({ raw: m[0].trim(), ...parsed })
    }
  }
  return found
}

// A run of day numbers before or after a month name: "11 to 13 December",
// "11, 12 and 13 December", "December 11-13".
const RUN = `((?:\\d{1,2}${ORD})(?:\\s*(?:,|and|to|until|through|-|–|—)\\s*\\d{1,2}${ORD})+)`
const RANGES: Array<{ re: RegExp; runAt: number; monthAt: number }> = [
  { re: new RegExp(`\\b${RUN}\\s+(?:of\\s+)?${M}\\b`, 'gi'), runAt: 1, monthAt: 2 },
  { re: new RegExp(`\\b${M}\\s+${RUN}`, 'gi'), runAt: 2, monthAt: 1 },
]

interface Grounded { keys: Set<string>; years: Set<string> }

function groundedFrom(prompt: string): Grounded {
  const keys = new Set<string>()
  const years = new Set<string>()
  for (const y of prompt.match(/\b(?:19|20)\d{2}\b/g) || []) years.add(y)
  for (const m of findDates(prompt)) {
    for (const k of m.keys) keys.add(k)
    // A stated day grounds its month too, so a draft saying "in December" is
    // covered by facts that say "11 to 13 December 2026".
    for (const mo of m.months) keys.add(monthKey(mo))
  }
  // The festival is a three-day range and the facts state it as one. Without
  // expansion "12 December" reads as ungrounded against "11 to 13 December 2026".
  for (const { re, runAt, monthAt } of RANGES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(prompt)) !== null) {
      const mo = month(m[monthAt])
      const nums = (m[runAt].match(/\d{1,2}/g) || []).map(Number).filter((n) => n >= 1 && n <= 31)
      if (!mo || !nums.length) continue
      keys.add(monthKey(mo))
      for (let d = Math.min(...nums); d <= Math.max(...nums); d++) keys.add(dayKey(mo, d))
    }
  }
  return { keys, years }
}

function isGrounded(m: DateMention, g: Grounded): boolean {
  // A right day in a wrong year is still a wrong date.
  if (m.year && !g.years.has(m.year)) return false
  return m.keys.some((k) => g.keys.has(k))
}

/** Every date in `text` that the prompt never supplied. Empty means clean. */
export function ungroundedDates(text: string, prompt: string): string[] {
  const g = groundedFrom(prompt)
  return findDates(text).filter((m) => !isGrounded(m, g)).map((m) => m.raw)
}

export interface DateGuardResult {
  text: string
  replaced: boolean
  ungrounded: string[]
}

/**
 * Drop any sentence that states a date the prompt did not contain, and say the
 * team will confirm instead. `prompt` must be the full system + user text the
 * draft was generated from: the vendor's own message is grounding too, so
 * answering "we will call you after 5 August" when she wrote 5 August is fine.
 */
export function guardUngroundedDates(text: string, prompt: string): DateGuardResult {
  if (!text || !text.trim()) return { text: text || '', replaced: false, ungrounded: [] }
  const g = groundedFrom(prompt)
  const ungrounded: string[] = []
  const out = text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      let deferred = false
      const kept: string[] = []
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        const bad = findDates(sentence).filter((m) => !isGrounded(m, g))
        if (!bad.length) {
          kept.push(sentence)
          continue
        }
        ungrounded.push(...bad.map((m) => m.raw))
        // One deferral per paragraph, however many sentences guessed.
        if (!deferred) kept.push(DATE_DEFER_LINE)
        deferred = true
      }
      return kept.join(' ')
    })
    .join('\n')
  return { text: out, replaced: ungrounded.length > 0, ungrounded }
}
