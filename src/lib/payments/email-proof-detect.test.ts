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

test('a payment word buried in the quoted reply chain is NOT a proof (maspark signage agreement, 2026-09-07)', () => {
  const body = [
    'Slm Altaaf,',
    'As discussed, the agreed changes have been made to the agreement.',
    'Please find attached signed doc.',
    'Kind regards,',
    '________________________________',
    'From: Capetown Halaal <capetownhalaal@gmail.com>',
    'Subject: Re: Quotes for Artwork and Signage.',
    'We can do the pop-up banners and POP displays, EFT the deposit to bank acc 123.',
  ].join('\n')
  assert.equal(looksLikeProofEmail({ subject: 'Re: Quotes for Artwork and Signage.', body, attachments: [att({ filename: '1616_001.pdf' })] }), false)
})

test('"pop up" / "pop-up" (signage) is not read as POP (proof of payment)', () => {
  assert.equal(looksLikeProofEmail({ subject: 'Pop-up banner quote', body: 'quote for your pop up stand', attachments: [att({ filename: 'quote.pdf' })] }), false)
})

test('"POP attached" in the sender message is still a proof', () => {
  assert.equal(looksLikeProofEmail({ subject: 'POP attached', body: 'paid, POP attached', attachments: [att({ filename: 'scan.pdf' })] }), true)
})

test('a quotes/signage/agreement subject is not a proof on a weak payment word alone (know the difference)', () => {
  // A supplier on the "Quotes for Artwork and Signage" thread whose new text has a
  // payment word but no "payment made" -> not a proof.
  assert.equal(looksLikeProofEmail({ subject: 'Re: Quotes for Artwork and Signage', body: 'EFT the deposit to acc 123 for the pop up banners', attachments: [att({ filename: '1616_001.pdf' })] }), false)
  assert.equal(looksLikeProofEmail({ subject: 'Sponsorship agreement', body: 'signed doc attached', attachments: [att({ filename: 'scan.pdf' })] }), false)
})

test('an explicit proof still wins over a quote/agreement subject', () => {
  // Strong "payment made" phrase in the sender text overrides the subject guard.
  assert.equal(looksLikeProofEmail({ subject: 'Re: Quotes for Artwork and Signage', body: 'Payment made, proof of payment attached', attachments: [att({ filename: 'scan.pdf' })] }), true)
  // A proof-ish FILENAME wins regardless of the subject.
  assert.equal(looksLikeProofEmail({ subject: 'Re: Quotes for Signage', body: 'see attached', attachments: [att({ filename: 'ProofOfPayment.pdf' })] }), true)
})

test('stripQuotedReply keeps the sender message and drops the quoted history', async () => {
  const { stripQuotedReply } = await import('./email-proof-detect')
  const body = 'Please find my proof of payment.\n\nOn Mon, Sep 1 2026, Sarah wrote:\n> here are our banking details, EFT to...'
  assert.match(stripQuotedReply(body), /proof of payment/)
  assert.ok(!/banking details/.test(stripQuotedReply(body)), 'the quoted chain is dropped')
})

test('referenceFromProofText reads the reference line every SA bank prints', async () => {
  const { referenceFromProofText } = await import('./eft-proof-shared')
  assert.equal(referenceFromProofText('Payee Details\nName : Halaal Hub\nReference : CTH830EF5\nEND'), 'CTH830EF5')
  assert.equal(referenceFromProofText('Amount R12 000.00\nPayment reference CTHCE8557\nIMPORTANT'), 'CTHCE8557')
  assert.equal(referenceFromProofText('Beneficiary reference ISLAND WAY SORBET\nAmount R5400.00'), 'ISLAND WAY SORBET')
  assert.equal(referenceFromProofText('Statement Reference\nYAH - O-0F246CD9\n'), 'YAH - O-0F246CD9')
  // the bank's own reference NUMBER is not the vendor's reference
  assert.equal(referenceFromProofText('Reference number 4134150361\nBeneficiary name X'), null)
  assert.equal(referenceFromProofText('You have paid R3 700 to Halal Hub'), null)
})

test('isPlanRequestEmail matches real plan asks and ignores ordinary mail', async () => {
  const { isPlanRequestEmail } = await import('./plan-email-autoreply')
  assert.equal(isPlanRequestEmail('Re: Final notice, stall fee overdue, Bee Pure', 'Is there any arrangement that can be made? R6500 is a bit much. what is the best arrangement that can be made?'), true)
  assert.equal(isPlanRequestEmail('The Scarf Lab', 'can I do a payment arrange in 3 parts, at least 2 part payment'), true)
  assert.equal(isPlanRequestEmail(null, 'Could I pay a deposit now and the rest later?'), true)
  assert.equal(isPlanRequestEmail('Load-in', 'What time can I set up my stall on the Friday?'), false)
  assert.equal(isPlanRequestEmail('Proof of payment', 'Please find my proof of payment attached.'), false)
})
