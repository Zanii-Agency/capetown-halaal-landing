import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FESTIVAL_FACTS,
  SPECIFICS_RULE,
  DATE_DEFER_LINE,
  ungroundedDates,
  guardUngroundedDates,
} from '@/lib/ai-grounding'
import { draftSystemPrompt } from '@/lib/email-concierge'

// What the email drafter's prompt actually contained on 2026-07-27: no festival
// facts, no date, and a vendor asking where her application stood.
const PROMPT_THAT_PRODUCED_IT =
  'You draft email replies on behalf of the Cape Town Halaal Festival team.\n' +
  '<EMAIL>\nFrom: a vendor\nSubject: Application status\n\n' +
  'Good day, I applied a while back and have not heard anything. Please can you tell me where my application stands?\n</EMAIL>'

const OFFENDING =
  'Our application review process concludes on 1 June 2026, when all applicants ' +
  'receive a personal email with their outcome. Since we are still within the ' +
  'review period, your status email is on its way.'

test('the actual sentence that caused this', () => {
  assert.deepEqual(ungroundedDates(OFFENDING, PROMPT_THAT_PRODUCED_IT), ['1 June 2026'])
  const out = guardUngroundedDates(OFFENDING, PROMPT_THAT_PRODUCED_IT)
  assert.equal(out.replaced, true)
  assert.doesNotMatch(out.text, /1 June 2026/)
  assert.match(out.text, /confirm that with the team/)
  // The sentence that did not guess survives.
  assert.match(out.text, /your status email is on its way/)
})

test('the same sentence is still caught with the new grounded prompt in front of it', () => {
  // FESTIVAL_FACTS names December and the clock names July, so June is invented
  // either way. A guard that only worked against an empty prompt would be useless.
  const prompt = draftSystemPrompt('') + '\n' + PROMPT_THAT_PRODUCED_IT
  assert.deepEqual(ungroundedDates(OFFENDING, prompt), ['1 June 2026'])
})

test('the drafter prompt carries the facts and the rule, not just the guard', () => {
  const p = draftSystemPrompt('')
  assert.match(p, /11 to 13 December 2026/)
  assert.match(p, /SPECIFICS YOU MAY STATE/)
  assert.match(p, /Current trusted datetime/)
  // Law 7: the prompt itself must not teach an em-dash.
  assert.doesNotMatch(p, /[—–]/)
})

test('the rule is a permission, not another "do not hallucinate"', () => {
  assert.match(SPECIFICS_RULE, /belongs in your reply only when it is written/)
  assert.match(SPECIFICS_RULE, /confirm it with the team/)
})

test('the festival dates the team really does know are left alone', () => {
  for (const s of [
    'The festival runs 11 to 13 December 2026 at Youngsfield Military Base.',
    'We are open on 12 December 2026, gates from early morning.',
    'See you in December, stalls are filling up.',
    'Your weekend pass covers 11, 12 and 13 December.',
  ]) {
    const out = guardUngroundedDates(s, FESTIVAL_FACTS)
    assert.equal(out.replaced, false, `wrongly replaced: ${s}`)
    assert.equal(out.text, s)
  }
})

test('a date the vendor herself wrote is not an invention', () => {
  // Her own message is in the prompt, so echoing it back is grounded.
  const prompt = `${FESTIVAL_FACTS}\n<EMAIL>\nI am away until 5 August 2026, please call me after that.\n</EMAIL>`
  const reply = 'No problem, we will only call you after 5 August 2026.'
  assert.deepEqual(ungroundedDates(reply, prompt), [])
  assert.equal(guardUngroundedDates(reply, prompt).text, reply)
})

test('a policy date nobody put in the prompt does not ship', () => {
  // 31 August is real, but it lives in the WhatsApp bot's prompt. If this drafter
  // was not handed it, it is guessing that the same date applies here.
  const out = guardUngroundedDates(
    'You have until 31 August 2026 to settle the full amount.',
    FESTIVAL_FACTS,
  )
  assert.equal(out.replaced, true)
  assert.deepEqual(out.ungrounded, ['31 August 2026'])
  assert.equal(out.text, DATE_DEFER_LINE)
  // And it passes once the prompt actually says it.
  const grounded = `${FESTIVAL_FACTS}\n- Part payment: settle in full by 31 August 2026.`
  assert.equal(guardUngroundedDates('You have until 31 August 2026 to settle the full amount.', grounded).replaced, false)
})

test('the right day in the wrong year is a wrong date', () => {
  const out = guardUngroundedDates('The festival is 11 to 13 December 2027.', FESTIVAL_FACTS)
  assert.equal(out.replaced, true)
  assert.equal(out.text, DATE_DEFER_LINE)
})

test('numeric and written date shapes are all caught', () => {
  for (const s of [
    'Applications close on 2026-06-01.',
    'Applications close on 01/06/2026.',
    'Applications close on June 1, 2026.',
    'Applications close on the 1st of June 2026.',
    'You will hear back in June.',
    'Outcomes go out by March 2026.',
  ]) {
    assert.equal(guardUngroundedDates(s, FESTIVAL_FACTS).replaced, true, `missed: ${s}`)
  }
})

test('ordinary English is not a date', () => {
  // "may" and "march" are the words that would break a naive month matcher, and
  // a stall code, a price, a phone number and a count are all bare digits.
  for (const s of [
    'It may take a few working days for the team to come back to you.',
    'Approval may only take a week, we will let you know.',
    'Your stall F12 is confirmed and 3 badges are allocated.',
    'Tickets are R30 per day and R60 for the weekend pass.',
    'Call us on +27659435012 if the payment fails.',
    'We received 264 applications this cycle.',
  ]) {
    const out = guardUngroundedDates(s, FESTIVAL_FACTS)
    assert.equal(out.replaced, false, `false positive: ${s}`)
    assert.equal(out.text, s)
  }
})

test('a multi-line reply keeps its shape and defers once per paragraph', () => {
  const reply =
    'Assalamu alaikum Fatima,\n\n' +
    'Thank you for checking in. Outcomes go out on 1 June 2026. We will also confirm on 2 June 2026.\n\n' +
    'Cape Town Halaal Festival Team'
  const out = guardUngroundedDates(reply, FESTIVAL_FACTS)
  assert.equal(out.ungrounded.length, 2)
  assert.match(out.text, /^Assalamu alaikum Fatima,\n\n/)
  assert.match(out.text, /Cape Town Halaal Festival Team$/)
  assert.match(out.text, /Thank you for checking in\. /)
  assert.equal(out.text.split(DATE_DEFER_LINE).length - 1, 1)
})

test('the deferral never carries a date of its own', () => {
  assert.deepEqual(ungroundedDates(DATE_DEFER_LINE, ''), [])
  assert.doesNotMatch(DATE_DEFER_LINE, /[—–]/)
})

test('empty input is safe', () => {
  assert.equal(guardUngroundedDates('', FESTIVAL_FACTS).replaced, false)
  assert.equal(guardUngroundedDates('   ', FESTIVAL_FACTS).text, '   ')
  assert.deepEqual(ungroundedDates('', ''), [])
})
