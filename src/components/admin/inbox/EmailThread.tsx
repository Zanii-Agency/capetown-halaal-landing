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
import { groupEmailTopics, topicOf, conversationTitle } from '@/lib/inbox/email-conversations'

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

function QuotedTail({ m }: { m: CommItem }) {
  const [show, setShow] = useState(false)
  if (!(m.bodyHtmlQuoted || m.bodyQuoted)) return null
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? 'Hide quoted text' : 'Show quoted text'}
        aria-expanded={show}
        className="inline-flex items-center px-1.5 py-0.5 rounded bg-neutral-200/80 hover:bg-neutral-300 text-neutral-600"
      >
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
      {show && (
        <div className="mt-2 pl-2 border-l-2 border-neutral-200 text-neutral-500">
          <Body m={m} quoted />
        </div>
      )}
    </div>
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
          {m.from}
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
          {initials(m.from || '?')}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-neutral-900">{m.from}</span>
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

/** A topic's system/auto emails (reminders, confirmations, password resets)
 *  folded into one line, "N system emails · last: <subject>", so the human
 *  exchange reads first (Taona 2026-09-12). One click reveals each email as a
 *  collapsed row whose snippet is its first line. */
function SystemGroup({ items }: { items: CommItem[] }) {
  const [open, setOpen] = useState(false)
  const last = items[items.length - 1]
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
          {items.length} system email{items.length === 1 ? '' : 's'}
          <span className="text-neutral-400 font-normal"> · last: {conversationTitle(last?.subject)}</span>
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

/** One human email in the timeline: inbound left, outbound right, full body. */
function TimelineCard({ m }: { m: CommItem }) {
  const out = m.direction === 'out'
  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'} min-w-0`}>
      <div className={`w-full max-w-[85%] rounded-lg border bg-white shadow-sm min-w-0 ${out ? 'border-neutral-200 border-r-2 border-r-[#cd2653]' : 'border-neutral-200'}`}>
        <div className={`flex items-center gap-2 px-3 pt-2 pb-1.5 border-b border-neutral-100 min-w-0 ${out ? 'flex-row-reverse text-right' : ''}`}>
          <span className="shrink-0 w-6 h-6 rounded-full bg-neutral-200 text-neutral-600 text-[10px] font-semibold grid place-items-center">
            {initials(m.from || '?')}
          </span>
          <span className="min-w-0 flex-1">
            <span className={`flex items-baseline gap-1.5 flex-wrap ${out ? 'justify-end' : ''}`}>
              <span className="text-[13px] font-semibold text-neutral-900">{m.from}</span>
              <span className="text-[11px] text-neutral-400">{fmtSAST(m.sentAt || m.at)}</span>
              {m.held && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border text-amber-800 bg-amber-50 border-amber-200">
                  Held, not delivered
                </span>
              )}
            </span>
            <span className="block text-[10px] font-medium text-neutral-500 truncate">
              {topicOf(m.subject).title} · {conversationTitle(m.subject)}
            </span>
          </span>
        </div>
        <div className="px-3 py-2.5 min-w-0">
          <Body m={m} quoted={false} />
          <QuotedTail m={m} />
          {!!m.media?.length && (
            <div className="mt-2 flex flex-wrap gap-2">
              {m.media.map((md, i) => <MediaBubble key={i} media={md} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** A system email as a thin divider; click reveals its body. */
function SystemDivider({ m }: { m: CommItem }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-neutral-400 hover:text-neutral-600 transition min-w-0"
      >
        <span className="flex-1 h-px bg-neutral-200" />
        <span className="shrink min-w-0 truncate text-[11px]">
          System: {conversationTitle(m.subject)} · {fmtSAST(m.sentAt || m.at)}
        </span>
        <span className="flex-1 h-px bg-neutral-200" />
      </button>
      {open && (
        <div className="mt-1.5 mx-auto max-w-[85%] rounded-lg border border-dashed border-neutral-200 bg-neutral-50/60 px-3 py-2 min-w-0">
          <Body m={m} quoted={false} />
        </div>
      )}
    </div>
  )
}

/** Chat-style timeline (Taona 2026-10-01): one list per vendor, oldest at top.
 *  The workspace scrolls to the end when messages change. Pure re-render of the
 *  messages already fetched; no new queries. */
export function EmailTimeline({ messages }: { messages: CommItem[] }) {
  const [chip, setChip] = useState<string>('all')
  if (!messages.length) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-neutral-400">
        <Mail className="w-6 h-6 mb-2" />
        <span className="text-[13px]">No email in this conversation.</span>
      </div>
    )
  }
  const sorted = [...messages].sort((a, b) => (a.at < b.at ? -1 : 1))
  const topics = groupEmailTopics(sorted)
  const shown = chip === 'all' ? sorted : sorted.filter((m) => topicOf(m.subject).key === chip)
  return (
    <div className="flex flex-col gap-3 py-2">
      {topics.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {[{ key: 'all', title: 'All' }, ...topics].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setChip(t.key)}
              className={`text-[12px] font-medium px-2.5 py-1 rounded-full border transition ${chip === t.key ? 'border-[#cd2653] text-[#cd2653] bg-[#cd2653]/[0.05]' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
            >
              {t.title}
            </button>
          ))}
        </div>
      )}
      {shown.map((m) => (m.auto ? <SystemDivider key={m.id} m={m} /> : <TimelineCard key={m.id} m={m} />))}
    </div>
  )
}

export function EmailThread({ messages, onReply, replyTo }: {
  messages: CommItem[]
  /** Reply into a topic: receives the subject of that topic's newest message. */
  onReply?: (subject: string) => void
  /** Subject the composer is currently replying to (its topic is highlighted). */
  replyTo?: string | null
}) {
  const [chip, setChip] = useState<string>('all')
  if (!messages.length) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-neutral-400">
        <Mail className="w-6 h-6 mb-2" />
        <span className="text-[13px]">No email in this conversation.</span>
      </div>
    )
  }
  // Option 2 (Taona 2026-10-01): one row per vendor in the list, TOPIC sections in
  // here (lib/inbox/email-conversations topicOf), newest topic first. Grouping
  // only reorganises the messages this viewer already received from the lane-
  // scoped messages route; it never fetches anything.
  const topics = groupEmailTopics(messages)
  const replyKey = replyTo ? topicOf(replyTo).key : null
  const shown = chip === 'all' ? topics : topics.filter((t) => t.key === chip)

  return (
    <div className="flex flex-col gap-4 py-2">
      {topics.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {[{ key: 'all', title: 'All' }, ...topics].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setChip(t.key)}
              className={`text-[12px] font-medium px-2.5 py-1 rounded-full border transition ${chip === t.key ? 'border-[#cd2653] text-[#cd2653] bg-[#cd2653]/[0.05]' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
            >
              {t.title}
            </button>
          ))}
        </div>
      )}
      {shown.map((t) => {
        const human = t.messages.filter((m) => !m.auto)
        const auto = t.messages.filter((m) => m.auto)
        const lastHuman = human[human.length - 1]
        const active = replyKey === t.key
        return (
          <section key={t.key} className={`flex flex-col gap-2 rounded-xl p-2 ${active ? 'ring-2 ring-[#cd2653]/30 bg-[#cd2653]/[0.03]' : ''}`}>
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-[15px] font-semibold text-neutral-900 leading-snug truncate">{t.title}</h2>
                <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${t.open ? 'text-rose-700 bg-rose-50 border-rose-200' : 'text-neutral-500 bg-neutral-50 border-neutral-200'}`}>
                  {t.open ? 'Open' : 'Answered'}
                </span>
                <span className="shrink-0 text-[11px] text-neutral-400">{t.messages.length}</span>
              </div>
              {onReply && (
                <button
                  type="button"
                  onClick={() => onReply(t.replySubject)}
                  className={`shrink-0 text-[12px] font-medium px-2 py-1 rounded-md border transition ${active ? 'border-[#cd2653] text-[#cd2653] bg-white' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
                >
                  {active ? 'Replying here' : 'Reply'}
                </button>
              )}
            </div>
            {auto.length > 0 && <SystemGroup items={auto} />}
            {human.map((m) => <EmailMessage key={m.id} m={m} defaultExpanded={m.id === lastHuman?.id} />)}
          </section>
        )
      })}
    </div>
  )
}
