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

test('two subjects become two conversations; replies join their own; auto-only stays in time order', () => {
  const g = groupEmailConversations([
    m('1', 'Vendor Whatsapp Group', '2026-09-14T08:00:00Z', { direction: 'out', auto: true }),
    m('2', 'Re: Vendor Whatsapp Group', '2026-09-14T09:00:00Z'),
    m('3', 'Reminder, your stall fee', '2026-09-15T07:00:00Z', { direction: 'out', auto: true }),
    m('4', 'Payment plan', '2026-09-23T10:00:00Z', { direction: 'out' }),
    m('5', 'Re: Payment plan', '2026-09-23T12:00:00Z'),
    m('6', 'Re: Vendor Whatsapp Group', '2026-09-20T09:00:00Z', { direction: 'out' }),
  ])
  // Taona 2026-09-24: an automated-only subject keeps its own section in time order
  // (between the two real ones by its latest message), flagged so the view renders
  // it collapsed. It is NOT hoisted into a pool at the top.
  assert.deepEqual(
    g.conversations.map((c) => c.title),
    ['Reminder, your stall fee', 'Vendor Whatsapp Group', 'Payment plan'],
  )
  assert.deepEqual(g.conversations.map((c) => c.autoOnly), [true, false, false])
  const vwg = g.conversations.find((c) => c.title === 'Vendor Whatsapp Group')!
  assert.deepEqual(vwg.messages.map((x) => x.id), ['1', '2', '6'], 'auto notice stays inside its real conversation')
  const pp = g.conversations.find((c) => c.title === 'Payment plan')!
  assert.deepEqual(pp.messages.map((x) => x.id), ['4', '5'])
  assert.deepEqual(g.conversations[0].messages.map((x) => x.id), ['3'], 'the reminder-only section holds its message')
})

test('topicOf buckets subjects; unknown subjects keep their own Other section', async () => {
  const { topicOf, groupEmailTopics } = await import('./email-conversations')
  assert.equal(topicOf('Re: Reminder, your YAH Festival stall fee, Sataari').title, 'Stall payment')
  assert.equal(topicOf('Final notice: your stall will be cancelled').title, 'Stall payment')
  assert.equal(topicOf('Following up on your Young at Heart Festival stall payment').title, 'Stall payment')
  assert.equal(topicOf('Payment plans now available for your Young at Heart stall').title, 'Stall payment')
  assert.equal(topicOf('We are cancelling your stall, Young at Heart Festival 2026').title, 'Cancellation')
  assert.equal(topicOf('Action required: sign your vendor contract').title, 'Contract')
  assert.equal(topicOf('Your halaal certificate').title, 'Documents')
  assert.equal(topicOf("You're approved! Welcome to Young at Heart Festival 2026").title, 'Onboarding')
  assert.equal(topicOf('Your Young at Heart Festival exhibitor portal access').title, 'Onboarding')
  assert.deepEqual(topicOf('Re: Vendor Whatsapp Group'), { key: 'other:vendor whatsapp group', title: 'Vendor Whatsapp Group' })

  const t = groupEmailTopics([
    m('1', 'Reminder, your YAH Festival stall fee, X', '2026-09-10T08:00:00Z', { direction: 'out', auto: true }),
    m('2', 'Vendor Whatsapp Group', '2026-09-12T08:00:00Z', { direction: 'out' }),
    m('3', 'Re: Following up on your Young at Heart Festival stall payment', '2026-09-20T08:00:00Z'),
  ])
  assert.deepEqual(t.map((x) => x.title), ['Stall payment', 'Vendor Whatsapp Group'], 'newest topic first')
  assert.deepEqual(t[0].messages.map((x) => x.id), ['1', '3'])
  assert.equal(t[0].open, true)
  assert.equal(t[0].replySubject, 'Following up on your Young at Heart Festival stall payment')
  assert.equal(t[1].open, false)
})

test('latestReplySubject prefers the newest human inbound email', async () => {
  const { latestReplySubject } = await import('./email-conversations')
  const msgs = [
    m('1', 'Payment plan', '2026-09-01T00:00:00Z'),
    m('2', 'Re: Contract', '2026-09-03T00:00:00Z'),
    m('3', 'Reminder, your stall fee', '2026-09-04T00:00:00Z', { auto: true } as Partial<CommItem>),
    m('4', 'Re: Payment plan', '2026-09-05T00:00:00Z', { direction: 'out' } as Partial<CommItem>),
  ]
  assert.equal(latestReplySubject(msgs), 'Contract')
  assert.equal(latestReplySubject([]), null)
})
