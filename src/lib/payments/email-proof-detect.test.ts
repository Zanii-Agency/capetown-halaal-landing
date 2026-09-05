import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeProofEmail, pickProofAttachment, isRealAttachment, type ProofAttachment } from './email-proof-detect'

// 2026-08-02, Taona: "if vendor emails proof of payment or via whatsapp, it
// should autopopulate on masterlane if it isnt acknowledged". A proof arriving
// by email must land the vendor on /admin/eft without a human noticing first.

function att(over: Partial<ProofAttachment>): ProofAttachment {
  return { filename: 'file.pdf', contentType: 'application/pdf', size: 1000, content: Buffer.from('x'), ...over }
}

test('a payment-ish filename alone is a proof', () => {
  assert.equal(looksLikeProofEmail({ subject: '', body: '', attachments: [att({ filename: 'ProofOfPayment.pdf' })] }), true)
  assert.equal(looksLikeProofEmail({ subject: '', body: '', attachments: [att({ filename: 'POP.jpeg', contentType: 'image/jpeg' })] }), true)
  assert.equal(looksLikeProofEmail({ subject: '', body: '', attachments: [att({ filename: 'EFT slip.pdf' })] }), true)
  assert.equal(looksLikeProofEmail({ subject: '', body: '', attachments: [att({ filename: 'bank notification.PDF' })] }), true)
})

test('payment wording in subject or body with any real attachment is a proof', () => {
  assert.equal(looksLikeProofEmail({ subject: 'Payment made today', body: '', attachments: [att({ filename: 'scan.pdf' })] }), true)
  assert.equal(looksLikeProofEmail({ subject: 'Hello', body: 'Please find my proof of payment attached.', attachments: [att({ filename: 'scan.pdf' })] }), true)
  assert.equal(looksLikeProofEmail({ subject: '', body: 'I just did the EFT, slip attached', attachments: [att({ filename: 'image.png', contentType: 'image/png' })] }), true)
})

test('no attachment means no proof, whatever the words say', () => {
  assert.equal(looksLikeProofEmail({ subject: 'Proof of payment', body: 'I paid', attachments: [] }), false)
})

test('neutral wording with a neutral attachment is not a proof', () => {
  assert.equal(looksLikeProofEmail({ subject: 'Here is my logo', body: 'for the stall', attachments: [att({ filename: 'logo.pdf' })] }), false)
})

test('inline signature graphics never count as proof attachments', () => {
  const inlineLogo = att({ filename: 'image001.png', contentType: 'image/png', contentDisposition: 'inline' })
  assert.equal(looksLikeProofEmail({ subject: 'payment made', body: '', attachments: [inlineLogo] }), false)
})

test('a lane vendor sending any real attachment counts (eager rule, same as WhatsApp)', () => {
  assert.equal(looksLikeProofEmail({ subject: '', body: '', attachments: [att({ filename: 'document.pdf' })], alreadyLane: true }), true)
})

test('pickProofAttachment prefers the payment-ish file and skips inline images', () => {
  const inlineLogo = att({ filename: 'sig.png', contentType: 'image/png', contentDisposition: 'inline' })
  const invoice = att({ filename: 'invoice.pdf' })
  const pop = att({ filename: 'proof-of-payment.pdf' })
  assert.equal(pickProofAttachment([inlineLogo, invoice, pop])?.filename, 'proof-of-payment.pdf')
  assert.equal(pickProofAttachment([inlineLogo, invoice])?.filename, 'invoice.pdf')
  assert.equal(pickProofAttachment([inlineLogo]), null)
})

test('oversized attachments are not picked', () => {
  const big = att({ filename: 'proof.pdf', size: 11 * 1024 * 1024 })
  assert.equal(pickProofAttachment([big]), null)
})

test('a large inline image (pasted bank screenshot) is a real attachment; a small inline logo is not', () => {
  const big = { filename: 'image001.jpg', contentType: 'image/jpeg', contentDisposition: 'inline', size: 320_000, content: Buffer.alloc(10) }
  const logo = { filename: 'logo.png', contentType: 'image/png', contentDisposition: 'inline', size: 8_000, content: Buffer.alloc(10) }
  assert.equal(isRealAttachment(big), true)
  assert.equal(isRealAttachment(logo), false)
  // iPhone Mail attaches a PDF as inline; a PDF is never a signature graphic.
  assert.equal(isRealAttachment({ filename: 'CTH payment.pdf', contentType: 'application/pdf', contentDisposition: 'inline', size: 67_645, content: Buffer.alloc(10) }), true)
  assert.equal(looksLikeProofEmail({ subject: 'Proof of payment', body: 'please see attached', attachments: [big] }), true)
  assert.equal(looksLikeProofEmail({ subject: 'Proof of payment', body: 'please see attached', attachments: [logo] }), false)
})
