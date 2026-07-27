/**
 * How a conversation list is split into the blocks the operator sees.
 *
 * THIS IS THE BUG THIS MODULE EXISTS FOR. Threads waiting on a human are pinned
 * to the top by `sortPinned` (channel-threads.ts). That quietly made the
 * "Waiting" tab a strict PREFIX of the "All" tab: with 31 of 50 pinned, the
 * first 31 rows of All WERE the Waiting tab, in the same order. Clicking between
 * them changed nothing on screen, so all three filters read as broken. Taona,
 * 2026-07-28: "its like they dont work". They worked. They had nothing visible
 * to show.
 *
 * So "All" CAPS the waiting run: a few pins, then a row carrying the rest that
 * jumps to the Waiting tab. The pinned-to-top promise is kept, the rest of the
 * mailbox becomes reachable without scrolling past every pin, and each tab
 * renders something the others do not.
 *
 * It lives here, not in the component, because it is the part that broke and the
 * part worth asserting. Rendering is not.
 */

import type { ChannelThread } from './channel-threads'

export type ThreadFilter = 'all' | 'waiting' | 'unread'

/** How many pins "All" shows before it hands the rest to the Waiting tab. */
export const WAITING_CAP = 3

export interface ThreadGroups {
  /** Waiting rows to render, already capped when the tab is "All". */
  waitingRows: ChannelThread[]
  /** Waiting rows the cap is holding back. 0 when nothing is capped. */
  hiddenWaiting: number
  /** Every waiting row that matched, capped or not. The divider counts this. */
  waitingTotal: number
  answered: ChannelThread[]
  /** Total matching rows, for the empty state. */
  total: number
}

export function groupThreads(shown: ChannelThread[], filter: ThreadFilter): ThreadGroups {
  const matching = shown.filter((t) =>
    filter === 'waiting' ? t.needs_response : filter === 'unread' ? t.unread : true)

  const waiting = matching.filter((t) => t.needs_response)
  const answered = matching.filter((t) => !t.needs_response)

  // Only "All" caps. Waiting is where you go to see them all, so capping there
  // would hide the very rows the tab exists to show.
  const capped = filter === 'all' && waiting.length > WAITING_CAP
  const waitingRows = capped ? waiting.slice(0, WAITING_CAP) : waiting

  return {
    waitingRows,
    hiddenWaiting: waiting.length - waitingRows.length,
    waitingTotal: waiting.length,
    answered,
    total: matching.length,
  }
}
