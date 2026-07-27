import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAcknowledgement } from '@/lib/bot/ack'

test('the message that started this: an approved vendor cheering', () => {
  // 2026-07-26 18:44. Answered with "Haha, love the energy! 😄 What's got you
  // excited, are we celebrating something specific or just feeling the vibes?"
  assert.equal(isAcknowledgement('Yeaaahh'), true)
})

test('closers and reactions end the conversation', () => {
  for (const s of ['thanks', 'Thank you', 'ok', 'Okay 👍', '👍', '❤️', '😄🎉', 'shukran', 'Cool', 'noted', 'Will do', 'Thanks so much!', 'lekker', 'jazakallah', 'Bye', 'yesss', 'thankssss']) {
    assert.equal(isAcknowledgement(s), true, `expected a closer: ${s}`)
  }
})

test('a question is never a closer, however short', () => {
  for (const s of ['ok?', 'thanks, and the stall?', 'yes?', 'What about payment?']) {
    assert.equal(isAcknowledgement(s), false, `expected a reply: ${s}`)
  }
})

test('real requests always get a reply', () => {
  for (const s of [
    'ok so where do I pay',
    'thanks, can you send the invoice',
    'yes I want the bigger stall',
    'I have not received my link',
    'Hi, my payment failed',
    'ok but I need to change my stall size please',
  ]) {
    assert.equal(isAcknowledgement(s), false, `expected a reply: ${s}`)
  }
})

test('empty and whitespace are not acknowledgements (nothing was said)', () => {
  assert.equal(isAcknowledgement(''), false)
  assert.equal(isAcknowledgement('   '), false)
  assert.equal(isAcknowledgement(null), false)
  assert.equal(isAcknowledgement(undefined), false)
})

test('a closer plus real content is content', () => {
  assert.equal(isAcknowledgement('thanks for the stall code F12 but it is wrong'), false)
})
