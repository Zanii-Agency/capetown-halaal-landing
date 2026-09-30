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
import { groupEmailConversations, conversationKey } from '@/lib/inbox/email-conversations'

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
        {m.held && (
          <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border text-amber-700 bg-amber-50 border-amber-200">
            Held
          </span>
        )}
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
            {m.held && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border text-amber-800 bg-amber-50 border-amber-200">
                Held, not delivered
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

/** A run of system/auto emails (reminders, confirmations, password resets)
 *  folded into one line so the real conversation reads first (Taona 2026-09-12:
 *  "these auto-gen messages are repetitive"). Collapsed by default; one click
 *  reveals the individual notifications, each still its own collapsible row.
 *  `title` is the subject when this run is a whole automated-only conversation,
 *  so the collapsed line still says what it is (Taona 2026-09-24). */
function SystemGroup({ items, title }: { items: CommItem[]; title?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left flex items-center gap-2 px-3 py-1.5 rounded-lg border border-dashed border-neutral-200 bg-neutral-50/60 hover:bg-neutral-100 transition text-neutral-500"
      >
        <ChevronDown className={`shrink-0 w-3.5 h-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-[12px] font-medium truncate">
          {title ? title : `${items.length} automated message${items.length === 1 ? '' : 's'}`}
          <span className="text-neutral-400 font-normal">{title ? ` · ${items.length} automated` : ' · reminders, confirmations, notices'}</span>
        </span>
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5 pl-2 border-l-2 border-neutral-100">
          {items.map((m) => <EmailMessage key={m.id} m={m} defaultExpanded={false} />)}
        </div>
      )}
    </div>
  )
}

export function EmailThread({ messages, onReply, replyTo }: {
  messages: CommItem[]
  /** Reply into THIS conversation (sets the composer's subject). */
  onReply?: (title: string) => void
  /** The conversation the composer is currently replying to. */
  replyTo?: string | null
}) {
  if (!messages.length) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-neutral-400">
        <Mail className="w-6 h-6 mb-2" />
        <span className="text-[13px]">No email in this conversation.</span>
      </div>
    )
  }
  // One row per address in the DB, but separate CONVERSATIONS on screen, split by
  // subject (lib/inbox/email-conversations). Every conversation, automated-only
  // ones included, is ordered by its latest message so the thread reads in the
  // order it happened (Taona 2026-09-24). An automated-only subject collapses to a
  // single folded line in that order; automated notices inside a real conversation
  // stay inline in that conversation's order.
  const { conversations } = groupEmailConversations(messages)
  const replyKey = replyTo ? conversationKey(replyTo) : null

  return (
    <div className="flex flex-col gap-4 py-2">
      {conversations.map((c, ci) => {
        // An automated-only conversation collapses to a single folded line in time
        // order — no section header, no Reply button (Taona 2026-09-24: "collapse
        // the automated sections"). The subject stays in the folded line so it still
        // says what it is.
        if (c.autoOnly) {
          return <SystemGroup key={c.key || `c${ci}`} items={c.messages} title={c.title} />
        }
        const lastRealId = [...c.messages].reverse().find((m) => !m.auto)?.id
        const blocks: Array<{ kind: 'real'; m: CommItem } | { kind: 'auto'; items: CommItem[] }> = []
        for (const m of c.messages) {
          if (m.auto) {
            const last = blocks[blocks.length - 1]
            if (last && last.kind === 'auto') last.items.push(m)
            else blocks.push({ kind: 'auto', items: [m] })
          } else {
            blocks.push({ kind: 'real', m })
          }
        }
        const active = replyKey !== null && replyKey === c.key
        const isLatest = ci === conversations.length - 1
        return (
          <section key={c.key || `c${ci}`} className={`flex flex-col gap-2 rounded-xl p-2 ${active ? 'ring-2 ring-[#cd2653]/30 bg-[#cd2653]/[0.03]' : ''}`}>
            <div className="flex items-start justify-between gap-2 px-1">
              <h2 className="text-[15px] font-semibold text-neutral-900 leading-snug break-words">{c.title}</h2>
              {onReply && (
                <button
                  type="button"
                  onClick={() => onReply(c.title)}
                  className={`shrink-0 text-[12px] font-medium px-2 py-1 rounded-md border transition ${active ? 'border-[#cd2653] text-[#cd2653] bg-white' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
                >
                  {active ? 'Replying here' : 'Reply'}
                </button>
              )}
            </div>
            {blocks.map((b, i) =>
              b.kind === 'auto'
                ? <SystemGroup key={`sys:${ci}:${i}`} items={b.items} />
                : <EmailMessage key={b.m.id} m={b.m} defaultExpanded={isLatest && b.m.id === lastRealId} />
            )}
          </section>
        )
      })}
    </div>
  )
}
