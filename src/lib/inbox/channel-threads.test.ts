import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortPinned, type ChannelThread } from '@/lib/inbox/channel-threads'

const t = (id: string, at: string, needs: boolean): ChannelThread => ({
  id, channel: 'whatsapp', peer_name: null, business_name: null, phone: null, email: null,
  application_id: null, subject: null, last_message_at: at, last_preview: null,
  last_direction: null, unread: false, needs_response: needs, bot_paused: false,
})

test('unresolved chats pin above everything, however old', () => {
  // This IS the retired Needs You queue. A vendor waiting since Tuesday outranks
  // a resolved thread that got a message a minute ago.
  const out = sortPinned([
    t('fresh-resolved', '2026-07-27T09:00:00Z', false),
    t('stale-waiting', '2026-07-21T08:00:00Z', true),
  ])
  assert.deepEqual(out.map((r) => r.id), ['stale-waiting', 'fresh-resolved'])
})

test('within each group, newest first', () => {
  const out = sortPinned([
    t('waiting-old', '2026-07-20T00:00:00Z', true),
    t('done-old', '2026-07-19T00:00:00Z', false),
    t('waiting-new', '2026-07-26T00:00:00Z', true),
    t('done-new', '2026-07-25T00:00:00Z', false),
  ])
  assert.deepEqual(out.map((r) => r.id), ['waiting-new', 'waiting-old', 'done-new', 'done-old'])
})

test('a missing timestamp sorts last rather than throwing', () => {
  const out = sortPinned([t('no-date', null as unknown as string, false), t('dated', '2026-07-26T00:00:00Z', false)])
  assert.equal(out[0].id, 'dated')
})
