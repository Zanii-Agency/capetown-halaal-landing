// Runs under `npm test`.
//
// The risk: a payment alert saying a vendor paid by EFT reaching the festival
// owner. She sees Yoco settlements and nothing else on the payment side, so this
// is the one rule that must never drift. Enumerating PAYMENT_METHODS means adding
// a sixth method breaks this test until someone decides who sees its alert.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { paymentAlertAudience, PAYMENT_METHODS, type PaymentMethod } from './confirm'
import { selectNotifyTargets } from '../bot/notify'
import { BOT_ADMINS } from '../bot/admins'

const EXPECTED: Record<PaymentMethod, 'all' | 'master'> = {
  yoco: 'all',          // the real settlement — always reaches the festival owner
  eft: 'master',        // never reaches her, in any circumstance
  samreen_eft: 'all',   // an EFT into HER reconciled account, confirmed by her: hers like Yoco
  manual_card: 'master', // operator-entered, taken outside Yoco — master lane
  cash: 'all',
  waived: 'all',
}

test('payment alerts route on the method: Yoco always to the owner, EFT never', () => {
  for (const m of PAYMENT_METHODS) {
    assert.equal(paymentAlertAudience(m), EXPECTED[m], `method '${m}' routes to the wrong audience`)
  }
})

test('every payment method has a declared audience', () => {
  // Fails the day a sixth method is added to PaymentMethod without a decision.
  assert.deepEqual([...PAYMENT_METHODS].sort(), Object.keys(EXPECTED).sort())
})

test('the audience actually excludes / includes the festival owner', () => {
  const roles = (m: PaymentMethod) =>
    selectNotifyTargets(BOT_ADMINS, {
      audience: paymentAlertAudience(m),
      excludeNorm: null,
      // eftContent false on purpose: the EFT case must hold on the AUDIENCE alone,
      // never on the body happening to contain the word "EFT". The top-up branch
      // renders "paid an ADDITIONAL R…" and never names the method.
      eftContent: false,
    }).map((a) => a.role).sort()

  assert.deepEqual(roles('eft'), ['master'], 'an EFT payment must never reach the festival owner')
  assert.deepEqual(roles('manual_card'), ['master'], 'a manual card capture must never reach her')
  assert.deepEqual(roles('yoco'), ['festival_owner', 'master'], 'a Yoco payment must always reach her')
  assert.deepEqual(roles('cash'), ['festival_owner', 'master'])
  assert.deepEqual(roles('samreen_eft'), ['festival_owner', 'master'], 'her own reconciled EFT must reach her')
  assert.deepEqual(roles('waived'), ['festival_owner', 'master'])
})
