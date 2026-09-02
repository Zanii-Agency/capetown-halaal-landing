import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTestVendor } from './test-vendors'

test('isTestVendor: catches the seed rows that sit in vendor_applications', () => {
  // The row that was queued for a real payment reminder on 2026-07-25.
  assert.equal(isTestVendor({ business_name: 'Demo Halal Kitchen', email: 'demo-vendor@cthalaal.co.za' }), true)
  assert.equal(isTestVendor({ business_name: 'Sweet Treats Demo', email: 'demo-sweet@cthalaal.co.za' }), true)
  assert.equal(isTestVendor({ business_name: 'probe-rate', email: 'abuse-probe@example.org' }), true)
})

test('isTestVendor: matches on name OR address, and ignores case and padding', () => {
  assert.equal(isTestVendor({ business_name: '  demo halal kitchen  ' }), true)
  assert.equal(isTestVendor({ business_name: 'DEMO HALAL KITCHEN' }), true)
  // Renamed seed row, still caught by the address.
  assert.equal(isTestVendor({ business_name: 'Some New Name', email: 'test-thing@cthalaal.co.za' }), true)
  assert.equal(isTestVendor({ business_name: 'Anything', email: 'someone@example.com' }), true)
})

test('isTestVendor: never swallows a real vendor', () => {
  const real = [
    { business_name: 'Papa Chai', email: 'salmaan@gmail.com' },
    { business_name: 'Kgotsos Pride', email: 'info@kgotsospride.co.za' },
    // "demo" inside a longer word, and a demo-ish product, must NOT match.
    { business_name: 'Demolition Donuts', email: 'hello@demolitiondonuts.co.za' },
    { business_name: 'The Test Kitchen', email: 'bookings@thetestkitchen.co.za' },
    { business_name: 'Saba', email: 'nazleyparker3@gmail.com' },
    { business_name: null, email: null },
    {},
  ]
  for (const v of real) assert.equal(isTestVendor(v), false, `${v.business_name} must not be treated as seed data`)
})
