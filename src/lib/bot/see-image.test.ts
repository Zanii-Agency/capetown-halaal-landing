import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseInbound } from '@/lib/whatsapp'

// THE MESSAGE THAT FORCED THIS (2026-07-30, +27662224202, "WITH LUV ZHAA"):
//
//   Zhaahira -> [image]  "Slms the link doesn't work"
//   Bot      -> "Thanks Zhaahira, got your document and it is on your
//                application. The team will take a look."
//
// Two defects in one reply. Her caption was discarded, and the image was never
// opened. Taona: "even this is a wrong response its suppose to scan the image
// quietly to understand context".

const HOOK = readFileSync(join(process.cwd(), 'src/app/api/whatsapp/webhook/route.ts'), 'utf8')
const SEE = readFileSync(join(process.cwd(), 'src/lib/bot/see-image.ts'), 'utf8')
const AGENT = readFileSync(join(process.cwd(), 'src/lib/bot/vendor-agent.ts'), 'utf8')

function payload(msg: Record<string, unknown>) {
  return { entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'WITH LUV ZHAA' } }], messages: [msg] } }] }] }
}

test("her caption survives parsing, so the bot always had her question", () => {
  // This was never the broken part, which is why the bug was invisible: the
  // text was present and the handler tested the TYPE instead of the text.
  const [m] = parseInbound(payload({
    from: '27662224202', id: 'wamid.test', type: 'image',
    image: { id: 'media-1', mime_type: 'image/jpeg', caption: "Slms the link doesn't work" },
  }))
  assert.equal(m.text, "Slms the link doesn't work")
  assert.equal(m.media?.kind, 'image')
})

test('a captioned image is no longer answered with the document ack', () => {
  const block = HOOK.slice(HOOK.indexOf('// MEDIA INBOUND'), HOOK.indexOf('// 3a-PENDING'))
  // The ack must sit behind "no caption AND nothing legible", not in front of
  // every non-text message. Anchor on the template literal, not the prose: the
  // comment above quotes the bad reply, and matching that passed a broken
  // assertion first time round.
  const ackAt = block.indexOf('`Thanks ${mediaSender.firstName}, got your document')
  const elseAt = block.indexOf('} else {')
  assert.ok(ackAt > -1 && elseAt > -1)
  assert.ok(elseAt < ackAt, 'the ack must live in the no-signal branch only')
  assert.ok(/const caption = msg\.text\.trim\(\)/.test(block), 'the caption must be read')
})

test('the image is actually opened', () => {
  const block = HOOK.slice(HOOK.indexOf('// MEDIA INBOUND'), HOOK.indexOf('// 3a-PENDING'))
  assert.ok(/await seeImage\(/.test(block), 'must call the vision read')
  assert.ok(/msg\.media\?\.kind === 'image'/.test(block), 'only images, not every attachment')
})

test('a screenshot of a problem routes to help, not to thanks', () => {
  const block = HOOK.slice(HOOK.indexOf('// MEDIA INBOUND'), HOOK.indexOf('// 3a-PENDING'))
  assert.ok(/isProblem/.test(block), 'must branch on a problem screenshot')
  assert.ok(/Do not thank them for a document/.test(block))
})

test('a payment proof is acknowledged without being confirmed as settled', () => {
  // Confirming money the finance side has not reconciled is the expensive
  // mistake here, so the context says what the bot may and may not assert.
  const block = HOOK.slice(HOOK.indexOf('// MEDIA INBOUND'), HOOK.indexOf('// 3a-PENDING'))
  assert.ok(/isPaymentProof/.test(block))
  assert.ok(/Do not confirm the payment as received or settled/.test(block))
})

test('vision failure degrades to the old behaviour, never to an error', () => {
  // A webhook that must return 200 fast cannot depend on a vision call.
  assert.ok(/return null/.test(SEE))
  assert.ok(/catch \(e\)/.test(SEE), 'every failure path returns null')
  assert.ok(/if \(!process\.env\.ANTHROPIC_API_KEY/.test(SEE), 'no key means no attempt')
  const block = HOOK.slice(HOOK.indexOf('// MEDIA INBOUND'), HOOK.indexOf('// 3a-PENDING'))
  assert.ok(/} else if \(caption\) {/.test(block), 'words alone still beat the canned ack')
})

test('only formats the vision API accepts are sent', () => {
  assert.ok(/image\/jpeg/.test(SEE) && /image\/png/.test(SEE) && /image\/webp/.test(SEE))
  assert.ok(/MAX_BYTES/.test(SEE), 'oversized images are skipped, not retried')
  assert.ok(/TIMEOUT_MS/.test(SEE), 'the webhook path needs a bounded wait')
})

test('the agent is told the bracket note is its own eyes', () => {
  assert.ok(/square brackets/.test(AGENT), 'the model must know what the note is')
  assert.ok(/cannot see that note/.test(AGENT), 'and that the vendor cannot see it')
})

test('the new vendor-facing copy carries no long dash (law 7)', () => {
  const block = HOOK.slice(HOOK.indexOf('// MEDIA INBOUND'), HOOK.indexOf('// 3a-PENDING'))
  const strings = [...(block.match(/`[^`]*`/g) || []), ...(SEE.match(/'[^']*'/g) || [])]
  assert.equal(/[—–]/.test(strings.join(' ')), false)
})
