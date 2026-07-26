'use client'

// The only inbox renderer either surface mounts.
//
// The unified inbox used to merge WhatsApp and email into ONE chronological
// bubble stream, which is neither app: a chat reads as a stream, a mail thread
// reads as a document, and interleaving them by timestamp gives you neither.
// This partitions by channel and hands each to a renderer built for it (Taona
// 2026-07-26: "I need the gmail, supportemail and whatsapp to show natively
// just like they do on their original apps").
//
// No API change: the route still returns one time-sorted array and we filter it
// here, so a contact with both channels is still a single round trip.
import { useMemo, useState } from 'react'
import { Loader2, MessageCircle, Mail } from 'lucide-react'
import type { CommItem, ThreadContact } from '@/lib/inbox/types'
import { WhatsAppStream } from './WhatsAppStream'
import { EmailThread } from './EmailThread'

export type Channel = 'whatsapp' | 'email'

export function ChannelPanes({
  messages,
  contact,
  loading,
  dense,
  onPaneChange,
}: {
  messages: CommItem[]
  contact: ThreadContact
  loading?: boolean
  /** NeedsYou renders compact. */
  dense?: boolean
  /** Lets the composer follow the pane, so the operator can never be reading
   *  email while the reply box is aimed at WhatsApp. */
  onPaneChange?: (ch: Channel) => void
}) {
  const wa = useMemo(() => messages.filter((m) => m.channel === 'whatsapp'), [messages])
  const email = useMemo(() => messages.filter((m) => m.channel === 'email'), [messages])

  const hasWa = wa.length > 0 || contact.channels.includes('whatsapp')
  const hasEmail = email.length > 0 || contact.channels.includes('email')
  const both = hasWa && hasEmail

  // Default to wherever they last spoke to us — the question the operator is
  // actually asking when they open a conversation. Lazily initialised, and the
  // parent keys this component on the contact id so it resets on switch without
  // a sync effect.
  const [pane, setPane] = useState<Channel>(() => {
    const last = messages[messages.length - 1]?.channel
    if (last) return last
    return hasWa ? 'whatsapp' : 'email'
  })
  const active: Channel = both ? pane : hasWa ? 'whatsapp' : 'email'

  const pick = (ch: Channel) => { setPane(ch); onPaneChange?.(ch) }

  if (loading && !messages.length) {
    return (
      <div className="flex items-center justify-center py-10 text-neutral-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col min-w-0">
      {/* Only when there is a genuine choice — one channel gets no dead chrome. */}
      {both && (
        <div className="sticky top-0 z-10 flex gap-1 p-1 mb-1 rounded-lg bg-neutral-100 self-start">
          {([
            ['whatsapp', 'WhatsApp', MessageCircle, wa.length],
            ['email', 'Email', Mail, email.length],
          ] as const).map(([ch, label, Icon, count]) => (
            <button
              key={ch}
              type="button"
              onClick={() => pick(ch)}
              aria-pressed={active === ch}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-semibold transition ${
                active === ch ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'
              }`}
            >
              <Icon className={`w-3.5 h-3.5 ${ch === 'whatsapp' ? 'text-emerald-600' : 'text-blue-600'}`} />
              {label}
              <span className="text-[10px] opacity-60">{count}</span>
            </button>
          ))}
        </div>
      )}

      {active === 'whatsapp'
        ? <WhatsAppStream messages={wa} dense={dense} />
        : <EmailThread messages={email} />}
    </div>
  )
}
