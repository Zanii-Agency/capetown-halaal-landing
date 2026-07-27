import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAutomatedEmail, canPin } from '@/lib/inbox/automated'

test('machines do not pin', () => {
  for (const e of [
    'noreply@someshop.com', 'no-reply@bank.co.za', 'donotreply@x.com',
    'newsletter@thing.com', 'deals@travel.com', 'notifications@app.io',
    'billing-alerts@vendor.com', 'mailer-daemon@mail.com', 'postmaster@x.org',
    'hello@list-manage.com', 'news@substack.com', 'x@mailchimp.com',
  ]) {
    assert.equal(isAutomatedEmail(e), true, `expected automated: ${e}`)
  }
})

test('a real person from a real company is not a machine', () => {
  // The whole risk of this filter is silencing genuine cold enquiries.
  for (const e of [
    'admin@somecompany.co.za', 'faadia.saban@hisplumbing.co.za',
    'adminct@printagon.co.za', 'tasneem@chocotag.com', 'someone@gmail.com',
    'sales@globalcuisine.co.za', 'info@thewokbar.com',
  ]) {
    assert.equal(isAutomatedEmail(e), false, `expected human: ${e}`)
  }
})

test('our own domains are self-notifications, never customers', () => {
  assert.equal(isAutomatedEmail('support@youngatheart.co.za'), true)
  assert.equal(isAutomatedEmail('taona@cthalaal.co.za'), true)
})

test('a KNOWN vendor always pins, however automated their address looks', () => {
  // A vendor trading as updates@ must not be silently demoted out of the queue.
  assert.equal(canPin({ email: 'updates@realvendor.co.za', application_id: 'abc' }), true)
  assert.equal(canPin({ email: 'noreply@realvendor.co.za', phone: '+27821234567' }), true)
})

test('an unresolved automated sender does not pin', () => {
  assert.equal(canPin({ email: 'deals@dollarflightclub.com' }), false)
})

test('an unresolved human sender still pins', () => {
  assert.equal(canPin({ email: 'someone@newcompany.co.za' }), true)
})

test('a missing address pins rather than being silently dropped', () => {
  assert.equal(canPin({}), true)
  assert.equal(isAutomatedEmail(null), false)
})
