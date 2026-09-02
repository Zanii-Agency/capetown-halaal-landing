import { test } from 'node:test'
import assert from 'node:assert/strict'
import { showsSiteFooter } from './site-chrome'

test('public routes get the site footer', () => {
  for (const p of ['/', '/about', '/apply', '/vendors', '/terms', '/privacy', '/contact', '/sectors/food']) {
    assert.equal(showsSiteFooter(p), true, `${p} is public`)
  }
})

test('the admin console and exhibitor portal do not', () => {
  for (const p of [
    '/admin', '/admin/login', '/admin/eft', '/admin/inbox/whatsapp',
    '/exhibitor', '/exhibitor/login', '/exhibitor/portal', '/exhibitor/portal/payments',
  ]) {
    assert.equal(showsSiteFooter(p), false, `${p} is a private app surface`)
  }
})

test('a public route that merely starts with the same letters is not swallowed', () => {
  // Prefix matching without a segment boundary would hide these by accident.
  for (const p of ['/administration', '/exhibitors', '/admin-guide']) {
    assert.equal(showsSiteFooter(p), true, `${p} must keep the footer`)
  }
})

test('a null pathname defaults to showing it', () => {
  // Failing open is right here: the cost is a footer on a page that did not want
  // one, not a missing legal strip on a page that legally needs it.
  assert.equal(showsSiteFooter(null), true)
  assert.equal(showsSiteFooter(undefined), true)
  assert.equal(showsSiteFooter(''), true)
})
