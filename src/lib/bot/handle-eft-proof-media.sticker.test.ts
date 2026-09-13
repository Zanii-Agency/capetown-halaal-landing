import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isProofMedia } from '@/lib/bot/handle-eft-proof-media'
import type { InboundMedia } from '@/lib/whatsapp'

// 2026-09-07: Bella and Co (unpaid, on a payment plan) tapped a thumbs-up sticker
// right after the bot confirmed her plan. The bot filed the sticker as an EFT
// proof and replied "proof of payment received", because the eager unpaid-vendor
// path captured ANY media without believing what it actually looked at. A
// sticker / voice note / video is never a payment proof, and a confident
// not-a-proof must override the eager capture-first net.

const media = (over: Partial<InboundMedia>): InboundMedia =>
  ({ kind: 'image', id: 'm1', mimeType: 'image/jpeg', ...over } as InboundMedia)

test('a sticker is a confident non-proof (looked:true), so eager cannot capture it', async () => {
  const r = await isProofMedia(media({ kind: 'sticker', mimeType: 'image/webp' }), '')
  assert.equal(r.yes, false)
  assert.equal(r.looked, true)
})

test('voice notes and videos are confident non-proofs too', async () => {
  for (const kind of ['audio', 'video'] as const) {
    const r = await isProofMedia(media({ kind }), '')
    assert.equal(r.yes, false, `${kind} is not a proof`)
    assert.equal(r.looked, true, `${kind} is a confident no`)
  }
})

// The decision the caller makes from isProofMedia's result. Read-first (Taona
// 2026-09-07): a proof is FILED only when it was READ and is one (`yes`). Media is
// never filed on the vendor's unpaid status alone. Unreadable media from a vendor
// we expect a payment from is ESCALATED to a human (never dropped, never claimed
// filed); anything else is IGNORED (the normal agent replies).
type Outcome = 'filed' | 'escalated' | 'ignored'
const decide = (yes: boolean, looked: boolean, eager: boolean): Outcome =>
  yes ? 'filed' : looked || !eager ? 'ignored' : 'escalated'

test('a proof is filed only after it is actually read and confirmed', () => {
  assert.equal(decide(true, true, false), 'filed', 'read + it is a proof -> filed')
  assert.equal(decide(false, true, true), 'ignored', 'eager + confident-no (sticker / vision-rejected) -> ignored, the bug is dead')
  assert.equal(decide(false, true, false), 'ignored', 'paid vendor logo (confident no) -> ignored')
  assert.equal(decide(false, false, true), 'escalated', 'could NOT read + expecting payment -> a human reads it, never auto-filed')
  assert.equal(decide(false, false, false), 'ignored', 'could not read + nobody expecting -> normal reply')
})
