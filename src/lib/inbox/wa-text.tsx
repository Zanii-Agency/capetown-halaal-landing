// WhatsApp's own text markup, rendered as React nodes.
//
// Vendors type *bold*, _italic_ and ~strike~ because that is what their phone
// does. Until 2026-07-26 the admin inbox showed the asterisks literally, so a
// message that reads cleanly on a phone read as noise to the operator.
//
// Returns ReactNode[], NOT an HTML string, so WhatsApp text never touches
// dangerouslySetInnerHTML and the XSS surface for this pane stays at zero.
// (Email is the opposite case — it is real HTML and goes through sanitize-html.)
import React from 'react'

// The lookarounds are the whole point. WhatsApp does not format `2*3*4` or
// `snake_case_name`, because a delimiter only counts when it is not surrounded
// by word characters. Without these, arithmetic and identifiers get mangled.
//
// SOURCES, not shared RegExp objects — a /g regex carries mutable lastIndex, and
// renderInline recurses (bold can contain italic). A nested call on a shared
// object resets lastIndex under the outer loop, which restarts it from zero:
// an infinite loop that pegged the CPU and OOM'd the process on the first
// *bold* message. Each invocation compiles its own instance instead.
const WA_MARKUP_SRC =
  String.raw`(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|(?<![\w~])~([^~\n]+)~(?![\w~])|` + '`([^`\\n]+)`'

const URL_SRC = String.raw`(https?:\/\/[^\s<]+)`

/** Linkify a plain run. URLs only — phone/email autolinking is scope creep. */
function linkify(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  const re = new RegExp(URL_SRC, 'g')
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <a
        key={`${keyBase}-a${m.index}`}
        href={m[1]}
        target="_blank"
        rel="noopener noreferrer"
        className="underline break-all"
      >
        {m[1]}
      </a>,
    )
    last = m.index + m[1].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  const re = new RegExp(WA_MARKUP_SRC, 'g')
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(...linkify(text.slice(last, m.index), `${keyBase}-t${last}`))
    const k = `${keyBase}-m${m.index}`
    if (m[1] !== undefined) out.push(<strong key={k}>{renderInline(m[1], k)}</strong>)
    else if (m[2] !== undefined) out.push(<em key={k}>{renderInline(m[2], k)}</em>)
    else if (m[3] !== undefined) out.push(<s key={k}>{renderInline(m[3], k)}</s>)
    else if (m[4] !== undefined) out.push(<code key={k} className="px-1 rounded bg-black/10 text-[13px]">{m[4]}</code>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(...linkify(text.slice(last), `${keyBase}-t${last}`))
  return out
}

/** Render WhatsApp-formatted text. Fenced ``` blocks are taken out first and
 *  passed through verbatim, so code inside them keeps its asterisks. */
export function renderWaText(text: string | null | undefined): React.ReactNode[] {
  const s = text || ''
  if (!s) return []
  const parts = s.split(/```/)
  const out: React.ReactNode[] = []
  parts.forEach((part, i) => {
    // Odd indices are the inside of a fence.
    if (i % 2 === 1) {
      out.push(
        <pre key={`f${i}`} className="my-1 px-2 py-1 rounded bg-black/10 whitespace-pre-wrap text-[13px]">
          {part}
        </pre>,
      )
    } else if (part) {
      out.push(...renderInline(part, `s${i}`))
    }
  })
  return out
}
