import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conversationKey, conversationTitle, groupEmailConversations } from './email-conversations'
import type { CommItem } from './types'

const m = (id: string, subject: string, at: string, extra: Partial<CommItem> = {}): CommItem =>
  ({ id, channel: 'email', direction: 'in', subject, at, body: '', ...extra }) as CommItem

test('conversationKey strips any Re/Fwd chain and case', () => {
  assert.equal(conversationKey('Re: RE: Fwd: Payment plan '), 'payment plan')
  assert.equal(conversationKey('FW: Payment  Plan'), 'payment plan')
  assert.equal(conversationKey('Re[2]: Payment plan'), 'payment plan')
  assert.equal(conversationKey(null), '')
  assert.equal(conversationTitle('Re: Vendor Whatsapp Group'), 'Vendor Whatsapp Group')
  assert.equal(conversationTitle(''), '(no subject)')
})

test('two subjects become two conversations; replies join their own; auto-only pooled', () => {
  const g = groupEmailConversations([
    m('1', 'Vendor Whatsapp Group', '2026-09-14T08:00:00Z', { direction: 'out', auto: true }),
    m('2', 'Re: Vendor Whatsapp Group', '2026-09-14T09:00:00Z'),
    m('3', 'Reminder, your stall fee', '2026-09-15T07:00:00Z', { direction: 'out', auto: true }),
    m('4', 'Payment plan', '2026-09-23T10:00:00Z', { direction: 'out' }),
    m('5', 'Re: Payment plan', '2026-09-23T12:00:00Z'),
    m('6', 'Re: Vendor Whatsapp Group', '2026-09-20T09:00:00Z', { direction: 'out' }),
  ])
  assert.deepEqual(g.conversations.map((c) => c.title), ['Vendor Whatsapp Group', 'Payment plan'])
  assert.deepEqual(g.conversations[0].messages.map((x) => x.id), ['1', '2', '6'], 'auto notice stays inside its real conversation')
  assert.deepEqual(g.conversations[1].messages.map((x) => x.id), ['4', '5'])
  assert.deepEqual(g.automated.map((x) => x.id), ['3'], 'a reminder-only subject is pooled, not its own section')
})
