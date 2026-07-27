'use client'

/**
 * The operator's controls for one conversation. Shared by all three channel
 * workspaces so a tool added here appears everywhere at once, which is the
 * failure the old inbox had: capabilities lived inside one 1,100-line client and
 * the new tabs shipped without any of them.
 *
 * TAKE OVER IS FIRST ON PURPOSE. Taona named it before anything else, and the
 * reason is concrete: without it the bot keeps answering a vendor while the
 * operator is typing to them. Handover is not a column (DDL is blocked, Law 8) —
 * escalateToHuman writes a [HUMAN_HANDOVER_ON] marker into wa_messages and the
 * webhook reads it back before replying, with a 24h auto-release.
 *
 * Everything here posts to endpoints that already existed and were simply never
 * called from the new pages.
 */

import { useState } from 'react'
import {
  Check, UserCog, Bot, Star, Clock, MailOpen, CircleCheck, Loader2, MoreHorizontal,
} from 'lucide-react'
import type { ChannelThread } from '@/lib/inbox/channel-threads'

interface Props {
  thread: ChannelThread
  /** Reload the list after any change. */
  onChanged: () => void
  onError: (msg: string) => void
}

export function ThreadToolbar({ thread, onChanged, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  async function post(url: string, body: unknown, key: string) {
    setBusy(key)
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (r.status === 403) throw new Error('You do not have permission for that.')
      if (!r.ok) throw new Error(`That did not save (${r.status})`)
      onChanged()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(null)
      setMenuOpen(false)
    }
  }

  const done = () => post('/api/admin/inbox/channel/done',
    { threadId: thread.id, done: thread.needs_response }, 'done')

  const handover = () => post('/api/admin/inbox/unified/handover',
    { phone: thread.phone, action: thread.bot_paused ? 'hand_back' : 'take_over' }, 'handover')

  // status endpoint keys on whichever identifier this thread actually has.
  const target = {
    ...(thread.application_id ? { applicationId: thread.application_id } : {}),
    ...(thread.email ? { email: thread.email } : {}),
    ...(thread.phone ? { phone: thread.phone } : {}),
  }
  const status = (action: string, extra: Record<string, unknown> = {}) =>
    post('/api/admin/inbox/unified/status', { action, ...target, ...extra }, action)

  const Icon = ({ k, I }: { k: string; I: typeof Check }) =>
    busy === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <I className="h-3.5 w-3.5" />

  return (
    <div className="flex items-center gap-2">
      {/* Take over: only meaningful where a bot actually answers. */}
      {thread.phone && (
        <button
          onClick={handover}
          disabled={!!busy}
          title={thread.bot_paused
            ? 'The bot is silent on this chat. Hand it back to resume automatic replies.'
            : 'The bot is answering this chat. Take over to silence it while you reply.'}
          className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2.5 py-1.5 border transition-colors disabled:opacity-50 ${
            thread.bot_paused
              ? 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
              : 'bg-white text-neutral-600 border-neutral-200 hover:bg-neutral-50'
          }`}
        >
          <Icon k="handover" I={thread.bot_paused ? Bot : UserCog} />
          {thread.bot_paused ? 'Hand back to bot' : 'Take over'}
        </button>
      )}

      <button
        onClick={done}
        disabled={!!busy}
        className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2.5 py-1.5 border transition-colors disabled:opacity-50 ${
          thread.needs_response
            ? 'bg-neutral-900 text-white border-neutral-900 hover:bg-neutral-800'
            : 'bg-white text-neutral-600 border-neutral-200 hover:bg-neutral-50'
        }`}
      >
        <Icon k="done" I={Check} />
        {thread.needs_response ? 'Mark done' : 'Reopen'}
      </button>

      <div className="relative">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          disabled={!!busy}
          aria-label="More actions"
          className="h-[30px] w-[30px] grid place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50 disabled:opacity-50"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 mt-1 z-20 w-48 rounded-lg border border-neutral-200 bg-white shadow-lg py-1 text-sm">
              <MenuItem onClick={() => status('star')} I={Star}>Star</MenuItem>
              <MenuItem onClick={() => status('unstar')} I={Star}>Unstar</MenuItem>
              <MenuItem
                onClick={() => status('snooze', { snoozeUntil: new Date(Date.now() + 864e5).toISOString() })}
                I={Clock}
              >
                Snooze 24 hours
              </MenuItem>
              <MenuItem onClick={() => status('unread')} I={MailOpen}>Mark unread</MenuItem>
              <MenuItem onClick={() => status('resolve')} I={CircleCheck}>Resolve</MenuItem>
              <MenuItem onClick={() => status('reopen')} I={CircleCheck}>Reopen thread</MenuItem>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function MenuItem({ onClick, I, children }: { onClick: () => void; I: typeof Star; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-50"
    >
      <I className="h-3.5 w-3.5 text-neutral-400" />
      {children}
    </button>
  )
}
