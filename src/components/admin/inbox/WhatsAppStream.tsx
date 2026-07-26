'use client'

// WhatsApp, rendered like WhatsApp.
//
// What changed from the old inline renderer (Taona 2026-07-26: "a chat should be
// straightforward"):
//   · consecutive messages from the same author group together. The old version
//     printed `icon · sender · time` above EVERY bubble, which was the single
//     largest source of visual noise in the thread.
//   · the inbound sender line is gone entirely. Real WhatsApp never shows a name
//     in a 1:1 chat — you know who you are talking to.
//   · the timestamp sits INSIDE the bubble, bottom-right, floated into the last
//     line of text, instead of floating above it as metadata.
//   · delivery ticks. wa_messages.status has been written by the webhook all
//     along and was simply never selected, so the inbox could not tell a
//     delivered message from a failed one.
//   · *bold* / _italic_ / ~strike~ / `code` render instead of showing literally.
import { Bot, Check, CheckCheck, Clock, AlertCircle } from 'lucide-react'
import type { CommItem } from '@/lib/inbox/types'
import { fmtTime, fmtDay } from '@/lib/inbox/format'
import { renderWaText } from '@/lib/inbox/wa-text'
import { MediaBubble } from './MediaBubble'

/** Same author, same direction, within 5 minutes — one visual group. */
const GROUP_WINDOW_MS = 5 * 60 * 1000
function sameGroup(a: CommItem | undefined, b: CommItem): boolean {
  if (!a) return false
  if (a.direction !== b.direction) return false
  if (!!a.bot !== !!b.bot) return false
  if (a.from !== b.from) return false
  return Math.abs(+new Date(b.at) - +new Date(a.at)) < GROUP_WINDOW_MS
}

function Ticks({ status, pending }: { status?: CommItem['status']; pending?: boolean }) {
  if (pending) return <Clock className="w-3 h-3 opacity-70" aria-label="Sending" />
  switch (status) {
    case 'read': return <CheckCheck className="w-3 h-3 text-sky-300" aria-label="Read" />
    case 'delivered': return <CheckCheck className="w-3 h-3" aria-label="Delivered" />
    case 'sent': return <Check className="w-3 h-3" aria-label="Sent" />
    case 'failed': return <AlertCircle className="w-3 h-3 text-amber-300" aria-label="Failed" />
    default: return null
  }
}

function WaBubble({ m, groupStart, dense }: { m: CommItem; groupStart: boolean; dense?: boolean }) {
  const isBot = m.direction === 'out' && m.bot
  const isOperator = m.direction === 'out' && !m.bot
  const out = m.direction === 'out'
  const mediaOnly = !!m.media?.length && !m.body

  const skin = isBot
    ? 'bg-neutral-100 text-neutral-700 border border-neutral-300'
    : isOperator
      ? 'bg-[#cd2653] text-white'
      : 'bg-white text-neutral-900 border border-neutral-200'
  // Only the FIRST bubble of a group gets the tail corner, exactly like the app.
  const corner = groupStart
    ? (out ? 'rounded-2xl rounded-tr-sm' : 'rounded-2xl rounded-tl-sm')
    : 'rounded-2xl'
  const pad = mediaOnly ? 'p-1' : 'px-3 py-2'

  return (
    <div className={`flex flex-col min-w-0 max-w-full ${out ? 'items-end' : 'items-start'} ${groupStart ? 'mt-3' : 'mt-0.5'}`}>
      {/* Only outbound needs an author, and only at the start of a group: the
          operator genuinely needs to know whether the bot or a human replied. */}
      {groupStart && out && (
        <div className="flex items-center gap-1 mb-0.5 px-1 text-[10px] text-neutral-400">
          {isBot
            ? <span className="inline-flex items-center gap-1 font-semibold"><Bot className="w-3 h-3" />Bot</span>
            : <span className="font-semibold text-[#cd2653]">{m.from === 'Bot' ? 'You' : m.from}</span>}
        </div>
      )}
      <div className={`relative shadow-sm overflow-hidden min-w-0 max-w-[78%] ${skin} ${corner} ${pad} ${m.pending ? 'opacity-60' : ''}`}>
        {!!m.media?.length && (
          <div className={`flex flex-col gap-1 ${m.body ? 'mb-1' : ''}`}>
            {m.media.map((md, i) => <MediaBubble key={i} media={md} onDark={isOperator} />)}
          </div>
        )}
        {m.body && (
          <p className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed ${dense ? 'text-[14px]' : 'text-[15px]'}`}>
            {renderWaText(m.body)}
            {/* Floated so short messages keep the stamp on the same line and long
                ones wrap around it — the native behaviour. */}
            <span className="float-right ml-2 mt-[3px] inline-flex items-center gap-0.5 text-[10px] leading-none opacity-60">
              {fmtTime(m.at)}
              {out && <Ticks status={m.status} pending={m.pending} />}
            </span>
          </p>
        )}
        {mediaOnly && (
          // No caption: overlay the stamp on the media, like the app does.
          <span className="absolute bottom-2 right-2 inline-flex items-center gap-0.5 rounded bg-black/45 px-1 py-0.5 text-[10px] leading-none text-white">
            {fmtTime(m.at)}
            {out && <Ticks status={m.status} pending={m.pending} />}
          </span>
        )}
      </div>
      {m.status === 'failed' && m.error && (
        <span className="mt-0.5 px-1 text-[10px] text-amber-600 max-w-[78%] truncate" title={m.error}>
          Not delivered: {m.error}
        </span>
      )}
    </div>
  )
}

export function WhatsAppStream({ messages, dense }: { messages: CommItem[]; dense?: boolean }) {
  const days: Array<{ day: string; items: CommItem[] }> = []
  for (const m of messages) {
    const day = fmtDay(m.at)
    const last = days[days.length - 1]
    if (last && last.day === day) last.items.push(m)
    else days.push({ day, items: [m] })
  }

  return (
    <div className="flex flex-col">
      {days.map((d) => (
        <div key={d.day} className="flex flex-col">
          <div className="self-center my-3 px-2.5 py-1 rounded-full bg-neutral-200/70 text-[11px] font-medium text-neutral-600">
            {d.day}
          </div>
          {d.items.map((m, i) => (
            <WaBubble key={m.id} m={m} groupStart={!sameGroup(d.items[i - 1], m)} dense={dense} />
          ))}
        </div>
      ))}
    </div>
  )
}
