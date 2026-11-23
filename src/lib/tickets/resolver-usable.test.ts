import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolverTicketsUsable, parseTicketsFromOrder, type ParsedTicket, type WCOrderWithMeta } from './verify'

const blank = (i: number): ParsedTicket => ({
  // The exact shape the live WP resolver returned on 2026-11-23: blank
  // ticket_id (mapped to synthetic) and product_id 1 (the meta index key).
  fooevents_ticket_id: `synthetic:9727:1:${i}`,
  product_id: 1,
  ticket_type: null,
  holder_first_name: null,
  holder_last_name: null,
  holder_email: null,
  holder_phone: null,
  attendance_date: null,
  raw: {},
})

describe('resolverTicketsUsable', () => {
  it('rejects null and empty results', () => {
    assert.equal(resolverTicketsUsable(null), false)
    assert.equal(resolverTicketsUsable([]), false)
  })

  it('rejects the blank rows the resolver returns for nested FooEvents meta', () => {
    assert.equal(resolverTicketsUsable([blank(1), blank(2)]), false)
  })

  it('accepts rows with a real FooEvents ticket id', () => {
    assert.equal(resolverTicketsUsable([{ ...blank(1), fooevents_ticket_id: '84213', product_id: 9454 }]), true)
  })

  it('accepts synthetic ids only when the product is a known ticket product', () => {
    assert.equal(resolverTicketsUsable([{ ...blank(1), product_id: 9450 }]), true)
  })
})

describe('parseTicketsFromOrder on the live nested FooEvents shape', () => {
  it('yields one Weekend ticket per attendee with the right product', () => {
    const ticket = { WooCommerceEventsProductID: '9454', WooCommerceEventsOrderID: '9727', WooCommerceEventsAttendeeName: '' }
    const order = {
      id: 9727,
      status: 'completed',
      line_items: [{ product_id: 9454, quantity: 3 }],
      meta_data: [{ key: 'WooCommerceEventsOrderTickets', value: { 1: { 1: ticket, 2: ticket, 3: ticket } } }],
    } as unknown as WCOrderWithMeta
    const out = parseTicketsFromOrder(order)
    assert.equal(out.length, 3)
    assert.ok(out.every((t) => t.product_id === 9454))
  })

  it('falls back to the purchaser name and email when attendee capture is off', () => {
    const ticket = {
      WooCommerceEventsProductID: '9450',
      WooCommerceEventsAttendeeName: '',
      WooCommerceEventsPurchaserFirstName: 'Amina',
      WooCommerceEventsPurchaserLastName: 'Test',
      WooCommerceEventsPurchaserEmail: 'amina@example.com',
    }
    const order = {
      id: 1,
      status: 'completed',
      line_items: [{ product_id: 9450, quantity: 1 }],
      meta_data: [{ key: 'WooCommerceEventsOrderTickets', value: { 1: { 1: ticket } } }],
    } as unknown as WCOrderWithMeta
    const [t] = parseTicketsFromOrder(order)
    assert.equal(t.holder_first_name, 'Amina')
    assert.equal(t.holder_last_name, 'Test')
    assert.equal(t.holder_email, 'amina@example.com')
  })
})
