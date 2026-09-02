// Split an email body into the part worth reading and the quoted tail.
//
// Nothing in this repo trimmed quotes before 2026-07-26, so a ten-message thread
// rendered the entire history ten times over — the operator's "hard to read", in
// one line. Gmail collapses it behind a "···"; so do we.
//
// Both halves are returned rather than the tail discarded: the quote is still
// evidence, it just should not be the default view.

export interface SplitBody {
  /** What renders by default. NEVER empty — if the whole body reads as quote,
   *  this is the whole body and `quoted` is null. An empty message bubble would
   *  be worse than a redundant one. */
  visible: string
  /** The trailing quote/signature, or null when there is none. */
  quoted: string | null
}

// Ordered by nothing in particular — we take the EARLIEST match across all of
// them, so the most aggressive cut wins.
const TEXT_MARKERS: RegExp[] = [
  /^On .{10,200}\bwrote:\s*$/m,            // Gmail, Apple Mail (English)
  /^-{2,}\s*Original Message\s*-{2,}/mi,   // Outlook
  /^_{10,}\s*$/m,                          // Outlook's horizontal rule
  /^From:\s.+\r?\n(Sent|Date):\s/mi,       // Outlook forwarded-header block
  /^--\s*$/m,                              // RFC 3676 signature delimiter
]

/** Split a PLAIN TEXT body. */
export function splitQuotedText(body: string | null | undefined): SplitBody {
  const s = body || ''
  if (!s.trim()) return { visible: s, quoted: null }

  let cut = -1
  for (const re of TEXT_MARKERS) {
    const m = re.exec(s)
    if (m && m.index > 0 && (cut === -1 || m.index < cut)) cut = m.index
  }

  // A `>`-prefixed run only counts when EVERY non-blank line from there to the
  // end is quoted. Otherwise we would cut at an inline quote the sender wrote
  // above their own reply, and hide the actual message.
  const gt = /^>{1,}/m.exec(s)
  if (gt && gt.index > 0 && (cut === -1 || gt.index < cut)) {
    const rest = s.slice(gt.index).split(/\r?\n/).filter((l) => l.trim())
    if (rest.length && rest.every((l) => l.trimStart().startsWith('>'))) cut = gt.index
  }

  if (cut <= 0) return { visible: s, quoted: null }
  const visible = s.slice(0, cut).trimEnd()
  // Guard: never hand back an empty message.
  if (!visible.trim()) return { visible: s, quoted: null }
  return { visible, quoted: s.slice(cut) }
}

// The container each real client wraps its quoted history in. We cut at the
// first one present. The cut lands mid-DOM, which is fine and is why callers
// must sanitise each half SEPARATELY — sanitize-html closes the unbalanced tags.
const HTML_MARKERS = [
  '<div class="gmail_quote',
  '<div class="gmail_signature',
  '<blockquote type="cite"',
  '<div id="appendonsend">',      // Outlook web
  '<div id="divRplyFwdMsg">',     // Outlook desktop
  '<hr id="stopSpelling">',       // older Outlook
  '<div class="yahoo_quoted',
]

/** Split an HTML body. Run this BEFORE sanitising, then sanitise both halves. */
export function splitQuotedHtml(html: string | null | undefined): SplitBody {
  const s = html || ''
  if (!s.trim()) return { visible: s, quoted: null }

  let cut = -1
  const lower = s.toLowerCase()
  for (const marker of HTML_MARKERS) {
    const i = lower.indexOf(marker)
    if (i > 0 && (cut === -1 || i < cut)) cut = i
  }

  if (cut <= 0) return { visible: s, quoted: null }
  const visible = s.slice(0, cut)
  // If everything before the marker is markup with no text, the "quote" IS the
  // message (a forward with no added comment). Show it rather than a blank card.
  if (!visible.replace(/<[^>]*>/g, '').trim()) return { visible: s, quoted: null }
  return { visible, quoted: s.slice(cut) }
}
