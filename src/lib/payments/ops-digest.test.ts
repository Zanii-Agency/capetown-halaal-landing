import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatOpsDigestWa, methodWord, type OpsDigest } from '@/lib/payments/ops-digest'

// formatOpsDigestWa is the channel-native formatter (the DB-backed builders are
// exercised live). It must: render the three sections, keep next-payer routing
// truthful, and carry no long dash (Law 7). Structured -> WhatsApp, not prose.

function tier(over: Partial<OpsDigest['rotation']['tiers'][number]>): OpsDigest['rotation']['tiers'][number] {
  return { slug: 'x', label: 'X', isSmall: false, received: 0, hasPending: false, nextThree: ['eft', 'eft', 'yoco'], ...over }
}

function digest(over: Partial<OpsDigest> = {}): OpsDigest {
  return {
    dateLabel: '4 August',
    opensToday: { count: 0, names: [] },
    paymentsToday: [],
    paidTotal: 0,
    rotation: { activated: true, startedAt: '2026-08-04T14:58:00Z', tiers: [] },
    ...over,
  }
}

test('renders paid, opens, and rotation sections', () => {
  const s = formatOpsDigestWa(digest({
    opensToday: { count: 2, names: ['Habibi', 'Soapretty'] },
    paymentsToday: [{ who: 'Vanilla Cream', amount: 6500, method: 'yoco' }],
    paidTotal: 6500,
    rotation: { activated: true, startedAt: 'x', tiers: [tier({ label: 'Marquee Full 3x3', isSmall: false, hasPending: true, nextThree: ['eft', 'eft', 'yoco'] })] },
  }))
  assert.match(s, /\*CTH daily pulse\* · 4 August/)
  assert.match(s, /\*Paid today: 1\*/)
  assert.match(s, /Vanilla Cream/)
  assert.match(s, /\*Opened portal today: 2\*/)
  assert.match(s, /Habibi, Soapretty/)
  assert.match(s, /Marquee Full 3x3: EFT/) // big tier at slot 0 -> next payer EFT
})

test('a small tier at slot 0 shows the next payer as Yoco (the mirror)', () => {
  const s = formatOpsDigestWa(digest({
    rotation: { activated: true, startedAt: 'x', tiers: [tier({ label: 'Marquee 2x2', isSmall: true, hasPending: true, nextThree: ['yoco', 'yoco', 'eft'] })] },
  }))
  assert.match(s, /Marquee 2x2: Yoco/)
})

test('only tiers with a pending vendor appear in the rotation list', () => {
  const s = formatOpsDigestWa(digest({
    rotation: { activated: true, startedAt: 'x', tiers: [
      tier({ label: 'Idle Tier', hasPending: false, nextThree: ['eft', 'eft', 'yoco'] }),
      tier({ label: 'Live Tier', hasPending: true, nextThree: ['eft', 'eft', 'yoco'] }),
    ] },
  }))
  assert.doesNotMatch(s, /Idle Tier/)
  assert.match(s, /Live Tier: EFT/)
})

test('zero-activity day still renders every section, no crash', () => {
  const s = formatOpsDigestWa(digest())
  assert.match(s, /\*Paid today: 0\*/)
  assert.match(s, /\*Opened portal today: 0\*/)
  assert.match(s, /no approved vendors awaiting payment/)
})

test('not-activated rotation says so', () => {
  const s = formatOpsDigestWa(digest({ rotation: { activated: false, startedAt: null, tiers: [] } }))
  assert.match(s, /not activated/)
})

test('the digest carries no long dash (law 7)', () => {
  const s = formatOpsDigestWa(digest({
    paymentsToday: [{ who: 'A', amount: 3700, method: 'eft' }],
    paidTotal: 3700,
    opensToday: { count: 1, names: ['B'] },
    rotation: { activated: true, startedAt: 'x', tiers: [tier({ label: 'T', hasPending: true })] },
  }))
  assert.equal(/[—–]/.test(s), false)
})

test('methodWord maps rails to readable words', () => {
  assert.equal(methodWord('yoco'), 'Yoco')
  assert.equal(methodWord('eft'), 'EFT')
  assert.equal(methodWord('fnb'), 'EFT')
  assert.equal(methodWord('manual_card'), 'card')
})
