// resolveVendorForEmail must resolve a vendor by their exact registered email
// (any domain), not only when a thread is pre-linked. Regression for the invoice
// auto-reply E2E (2026-09-07): with a null `exact`, a non-gmail vendor emailing
// from their registered address returned null, so no auto-reply fired.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveVendorForEmail } from './email-proof-intake'

function fakeDb(vendorsByEmail: Record<string, { id: string; email: string }>) {
  return {
    from(_table: string) {
      return {
        select() {
          return {
            // exact non-gmail path: ilike(email, from).limit(1)
            ilike(_col: string, pattern: string) {
              const key = pattern.replace(/%/g, '').toLowerCase()
              const hit = vendorsByEmail[key]
              return { limit: async () => ({ data: hit ? [hit] : [] }), then: undefined }
            },
            // thread path: eq('peer_email', from).maybeSingle()
            eq() { return { maybeSingle: async () => ({ data: null }) } },
          }
        },
      }
    },
  }
}

test('resolves a non-gmail vendor by exact registered email with a null exact', async () => {
  const db = fakeDb({ 'vendor@bizmail.co.za': { id: 'v1', email: 'vendor@bizmail.co.za' } })
  const v = await resolveVendorForEmail(db as never, 'Vendor@BizMail.co.za', null)
  assert.equal(v?.id, 'v1')
})

test('returns null when no vendor has that email and no thread is linked', async () => {
  const db = fakeDb({})
  const v = await resolveVendorForEmail(db as never, 'nobody@bizmail.co.za', null)
  assert.equal(v, null)
})
