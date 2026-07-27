'use client'

// Email, rendered like email.
//
// The old inbox pushed email through the WhatsApp bubble renderer using the
// PLAIN-TEXT column, so a formatted message arrived as a wall of flattened text
// with its whole quoted history repeated in every message. This is a Gmail-shaped
// reading list instead:
//   · full-width cards, not bubbles. No left/right alignment, no coloured
//     operator bubble — an email is a document, and outbound just gets a left
//     accent and "You".
//   · collapsed rows (sender, snippet, date) with the newest expanded, so a long
//     thread is scannable instead of a wall. The header row is the toggle in BOTH
//     directions: the same click that opens a message closes it again.
//   · sanitised HTML when the row has it, so structure survives. `bodyHtml` is
//     sanitised SERVER-SIDE in the messages route — this component trusts it by
//     contract and must never re-sanitise or accept HTML from anywhere else.
//   · the quoted tail hides behind Gmail's "···".
import { useState } from 'react'
import { ChevronDown, Mail, MoreHorizontal } from 'lucide-react'
import type { CommItem } from '@/lib/inbox/types'
import { fmtSAST, initials } from '@/lib/inbox/format'
import { MediaBubble } from './MediaBubble'

function Body({ m, quoted }: { m: CommItem; quoted: boolean }) {
  const html = quoted ? m.bodyHtmlQuoted : m.bodyHtml
  const text = quoted ? m.bodyQuoted : m.body
  if (html) {
    // Trusted by contract — sanitised in api/admin/inbox/unified/messages.
    return <div className="email-body max-w-none break-words" dangerouslySetInnerHTML={{ __html: html }} />
  }
  return (
    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[14px] leading-relaxed text-neutral-800">
      {text}
    </p>
  )
}

function EmailMessage({ m, defaultExpanded }: { m: CommItem; defaultExpanded: boolean }) {
  const [open, setOpen] = useState(defaultExpanded)
  const [showQuote, setShowQuote] = useState(false)
  const out = m.direction === 'out'
  const hasQuote = !!(m.bodyHtmlQuoted || m.bodyQuoted)
  const snippet = (m.body || '').replace(/\s+/g, ' ').trim().slice(0, 110)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        title="Expand"
        className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 bg-white hover:bg-neutral-50 transition min-w-0"
      >
        <ChevronDown className="shrink-0 w-3.5 h-3.5 text-neutral-400 -rotate-90" />
        <span className="shrink-0 w-6 h-6 rounded-full bg-neutral-200 text-neutral-600 text-[10px] font-semibold grid place-items-center">
          {initials(m.from || '?')}
        </span>
        <span className="shrink-0 text-[13px] font-semibold text-neutral-800 max-w-[10rem] truncate">
          {out ? 'You' : m.from}
        </span>
        <span className="flex-1 text-[13px] text-neutral-500 truncate min-w-0">{snippet}</span>
        <span className="shrink-0 text-[11px] text-neutral-400">{fmtSAST(m.at)}</span>
      </button>
    )
  }

  return (
    <div className={`rounded-lg border bg-white shadow-sm min-w-0 ${out ? 'border-neutral-200 border-l-2 border-l-[#cd2653]' : 'border-neutral-200'}`}>
      {/* The whole header is the close control. A collapse that hides in a
          corner glyph is one the operator never finds, so a long email stays
          open forever and every later message sits below a wall of scroll. */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-expanded
        title="Collapse"
        className="w-full text-left flex items-start gap-2 px-3 pt-2.5 pb-2 rounded-t-lg border-b border-neutral-200 bg-neutral-50 hover:bg-neutral-100 transition min-w-0"
      >
        <ChevronDown className="shrink-0 mt-2 w-3.5 h-3.5 text-neutral-500" />
        <span className="shrink-0 w-7 h-7 rounded-full bg-neutral-200 text-neutral-600 text-[11px] font-semibold grid place-items-center">
          {initials(out ? 'You' : m.from || '?')}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-neutral-900">{out ? 'You' : m.from}</span>
            {m.fromAddress && <span className="text-[11px] text-neutral-400 truncate">{m.fromAddress}</span>}
            {m.mailbox && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                m.mailbox === 'gmail'
                  ? 'text-rose-700 bg-rose-50 border-rose-200'
                  : 'text-blue-700 bg-blue-50 border-blue-200'
              }`}>
                {m.mailbox === 'gmail' ? 'Gmail' : 'YAH'}
              </span>
            )}
          </span>
          {m.to && <span className="block text-[11px] text-neutral-400 truncate">to {m.to}</span>}
        </span>
        {/* The sender's own send time, which is what a mail client shows. `at`
            is arrival, which is what the thread sorts on — they differ by the
            cron interval and occasionally by a skewed sender clock. */}
        <span className="shrink-0 text-[11px] text-neutral-400">{fmtSAST(m.sentAt || m.at)}</span>
      </button>

      <div className="px-3 py-2.5 min-w-0">
        <Body m={m} quoted={false} />

        {hasQuote && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setShowQuote((v) => !v)}
              aria-label={showQuote ? 'Hide quoted text' : 'Show quoted text'}
              aria-expanded={showQuote}
              className="inline-flex items-center px-1.5 py-0.5 rounded bg-neutral-200/80 hover:bg-neutral-300 text-neutral-600"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {showQuote && (
              <div className="mt-2 pl-2 border-l-2 border-neutral-200 text-neutral-500">
                <Body m={m} quoted />
              </div>
            )}
          </div>
        )}

        {!!m.media?.length && (
          <div className="mt-2 flex flex-wrap gap-2">
            {m.media.map((md, i) => <MediaBubble key={i} media={md} />)}
          </div>
        )}
      </div>
    </div>
  )
}

export function EmailThread({ messages }: { messages: CommItem[] }) {
  if (!messages.length) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-neutral-400">
        <Mail className="w-6 h-6 mb-2" />
        <span className="text-[13px]">No email in this conversation.</span>
      </div>
    )
  }
  const subject = messages.find((m) => m.subject)?.subject
  return (
    <div className="flex flex-col gap-2 py-2">
      {subject && (
        <h2 className="px-1 text-[15px] font-semibold text-neutral-900 leading-snug break-words">{subject}</h2>
      )}
      {messages.map((m, i) => (
        // Newest expanded, the rest collapsed — a single-message thread is
        // therefore always open.
        <EmailMessage key={m.id} m={m} defaultExpanded={i === messages.length - 1} />
      ))}
    </div>
  )
}
