import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldHoldNewEmail } from './held-email'

const scope = (unrestricted: boolean, blocked: string[] = []) => ({ unrestricted, blocks: (x: { email?: string | null }) => blocked.includes(String(x.email)) })
const wall = (blocked: string[]) => ({ blocks: (_p?: string | null, e?: string | null) => blocked.includes(String(e)) })

test('master (unrestricted) always sends', () => {
  assert.equal(shouldHoldNewEmail(scope(true), null, 'x@y.com'), false)
})
test('owner: walled vendor held (lane scope OR per-person wall), ordinary vendor sent', () => {
  assert.equal(shouldHoldNewEmail(scope(false, ['m@v.com']), wall([]), 'm@v.com'), true)
  assert.equal(shouldHoldNewEmail(scope(false), wall(['twin@v.com']), 'twin@v.com'), true)
  assert.equal(shouldHoldNewEmail(scope(false), wall([]), 'hers@v.com'), false)
})
test('owner: wall cannot load -> hold (fail closed)', () => {
  assert.equal(shouldHoldNewEmail(scope(false), null, 'hers@v.com'), true)
})
