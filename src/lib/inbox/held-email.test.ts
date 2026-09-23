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

test('per PERSON: a twin row with another email but a walled phone still holds', () => {
  const scopeByPhone = { unrestricted: false, blocks: (x: { phone?: string | null }) => x.phone === '27820000000' }
  const wallByPhone = { blocks: (p?: string | null) => p === '27820000000' }
  assert.equal(shouldHoldNewEmail(scopeByPhone, wallByPhone, 'other@v.com', [{ id: 'twin', phone: '27820000000' }]), true)
  assert.equal(shouldHoldNewEmail(scopeByPhone, wallByPhone, 'other@v.com', [{ id: 'x', phone: '27830000000' }]), false)
})
