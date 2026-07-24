import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectNotifyTargets } from './notify'
import { BOT_ADMINS } from './admins'
import { toE164 } from '@/lib/whatsapp'

const roles = (admins: { role: string }[]) => admins.map((a) => a.role).sort()

test('EFT-content alerts never reach the festival owner, in any mode', () => {
  // eftContent = true: Samreen (festival_owner) is dropped, master still gets it.
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'all', excludeNorm: null, eftContent: true })),
    ['master'],
  )
  // Even when the alert was explicitly addressed to the owner, EFT content wins.
  assert.deepEqual(
    selectNotifyTargets(BOT_ADMINS, { audience: 'festival_owner', excludeNorm: null, eftContent: true }),
    [],
  )
})

test('non-EFT alerts route normally', () => {
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'all', excludeNorm: null, eftContent: false })),
    ['festival_owner', 'master'],
  )
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'master', excludeNorm: null, eftContent: false })),
    ['master'],
  )
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'festival_owner', excludeNorm: null, eftContent: false })),
    ['festival_owner'],
  )
})

test('exclude filter drops a specific phone', () => {
  const owner = BOT_ADMINS.find((a) => a.role === 'festival_owner')!
  const got = selectNotifyTargets(BOT_ADMINS, { audience: 'all', excludeNorm: toE164(owner.phone), eftContent: false })
  assert.ok(!got.some((a) => a.role === 'festival_owner'))
})
