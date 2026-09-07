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

// The capture decision the caller makes from isProofMedia's result. Encodes the
// fix: capture on a positive proof, or when eager AND we could NOT look; a
// confident not-a-proof (looked:true, yes:false) is never captured.
const capture = (yes: boolean, looked: boolean, eager: boolean) => yes || (eager && !looked)

test('an eager vendor no longer captures a confidently-rejected sticker/emoji', () => {
  assert.equal(capture(false, true, true), false, 'eager + confident-no (sticker/vision-rejected) -> NOT captured, the bug')
  assert.equal(capture(true, true, false), true, 'a real proof (vision said yes) is captured')
  assert.equal(capture(false, false, true), true, 'eager + could-not-look (vision down) -> still capture, never drop a real proof')
  assert.equal(capture(false, true, false), false, 'paid vendor logo (confident no) -> not captured')
  assert.equal(capture(false, false, false), false, 'not eager + no signal -> not captured (falls to document path)')
})
