import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vendorIssues, vendorActions, loginContext, buildLoginAlert } from './vendor-activity'

test('a vendor who tried to pay and failed is the top issue', () => {
  // The highest-value signal on the whole list: they WANT to pay and something
  // is in their way. It must survive truncation, so it leads.
  const issues = vendorIssues({
    payment: { status: 'none', failed_attempts: 3, attempts: 3 },
    daysToDue: -5,
  })
  assert.match(issues[0], /3 failed payment attempts, still unpaid/)
  assert.ok(issues.some((i) => /5 days OVERDUE/.test(i)))
})

test('a paid vendor reports no payment issue', () => {
  const issues = vendorIssues({ payment: { status: 'paid', attempts: 2 }, daysToDue: -5, contractSignedAt: 'x' })
  assert.equal(issues.some((i) => /unpaid|OVERDUE/.test(i)), false)
})

test('an unreconciled proof is flagged, since it needs a human', () => {
  const issues = vendorIssues({ payment: { status: 'none', eft_submitted_at: '2026-07-28T00:00:00Z' }, contractSignedAt: 'x' })
  assert.ok(issues.some((i) => /proof that is still unreconciled/.test(i)))
})

test('asking for a human counts as an issue, not an action', () => {
  const issues = vendorIssues({
    contractSignedAt: 'x',
    events: [{ event_type: 'stall_move_requested', created_at: 'x' }, { event_type: 'stall_change_requested', created_at: 'y' }],
  })
  assert.ok(issues.some((i) => /2 unresolved requests raised/.test(i)))
})

test('terms and documents are NOT issues, because they fire on almost everyone', () => {
  // Measured 2026-07-29 across 171 approved vendors: 96% have no terms
  // timestamp, 97% have no documents. A line on 24 of every 25 alerts trains
  // the reader to skim the Issues block, which is where the failed-payment
  // line lives. Progress still reports document counts.
  const issues = vendorIssues({ contractSignedAt: 'x', docsUploaded: 0, docsRequired: 4 })
  assert.deepEqual(issues, [], 'no terms and no docs must produce no issue lines')
  assert.ok(vendorActions({ docsUploaded: 1, docsRequired: 4 }).some((a) => /1\/4 docs/.test(a)))
})

test('an unsigned contract IS an issue, it blocks payment', () => {
  // 42% of approved vendors, so it discriminates, and it explains being stuck.
  assert.ok(vendorIssues({}).some((i) => /has not signed the contract/.test(i)))
})

test('actions report progress', () => {
  const acts = vendorActions({
    payment: { status: 'paid' }, contractSignedAt: 'x', termsAcceptedAt: 'x',
    stallCode: 'B12', docsUploaded: 3, docsRequired: 4, staffCount: 2, logoUploaded: true,
  })
  assert.deepEqual(acts, ['paid', 'contract signed', 'terms accepted', 'stall B12', '3/4 docs', '2 staff members', 'logo up'])
})

test('login ordinals read naturally and include the gap', () => {
  const NOW = new Date('2026-07-29T12:00:00Z').getTime()
  assert.equal(loginContext([], NOW), 'first login')
  assert.match(loginContext([{ at: '2026-07-29T09:00:00Z' }], NOW), /^2nd login, last was 3h ago$/)
  assert.match(loginContext([{ at: '2026-07-27T12:00:00Z' }, { at: '2026-07-20T12:00:00Z' }], NOW), /^3rd login, last was 2d ago$/)
  assert.match(loginContext(Array(6).fill({ at: '2026-07-28T12:00:00Z' }), NOW), /^7th login/)
})

test('the alert leads with who and where, then issues before progress', () => {
  const msg = buildLoginAlert({
    businessName: 'Soapretty', contactName: 'Faadia', place: 'Cape Town, ZA', ip: '41.13.7.22',
    activity: {
      payment: { status: 'none', failed_attempts: 2 },
      daysToDue: -3, docsUploaded: 0, docsRequired: 2,
      contractSignedAt: '2026-07-01',
      inbound: [{ body: 'Please send banking details', created_at: 'x' }],
      priorLogins: [{ at: '2026-07-28T12:00:00Z' }],
    },
  })
  assert.match(msg, /^\*Soapretty \(Faadia\)\* just logged in\./)
  assert.match(msg, /Cape Town, ZA · 41\.13\.7\.22 · 2nd login/)
  // Issues must appear before Progress: a truncated alert still has to be useful.
  assert.ok(msg.indexOf('*Issues:*') < msg.indexOf('*Progress:*'))
  assert.match(msg, /2 failed payment attempts/)
  assert.match(msg, /\*Last said:\* "Please send banking details"/)
  // Law 7: no long dashes anywhere in operator copy either.
  assert.equal(/[—–]/.test(msg), false)
})

test('a clean vendor still produces a readable alert', () => {
  const msg = buildLoginAlert({
    businessName: "Jane's Exclusive", place: 'Cape Town, ZA', ip: null,
    activity: { payment: { status: 'paid' }, contractSignedAt: 'x', termsAcceptedAt: 'x', priorLogins: [] },
  })
  assert.match(msg, /first login/)
  assert.equal(msg.includes('*Issues:*'), false)
  assert.match(msg, /\*Progress:\* paid, contract signed, terms accepted/)
})

test('a vendor who has done nothing says so rather than printing an empty list', () => {
  const msg = buildLoginAlert({ businessName: 'New Co', place: 'an unknown location', ip: null, activity: {} })
  assert.match(msg, /\*Progress:\* nothing completed yet/)
})
