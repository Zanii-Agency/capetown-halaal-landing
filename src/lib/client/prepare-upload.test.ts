import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UPLOAD_LIMIT_BYTES, tooLargeMessage, FileTooLargeError } from './prepare-upload'

// The compression itself is DOM-bound (canvas/createImageBitmap) and runs in the
// browser. What must be right regardless is the vendor-facing contract: the cap
// sits under Vercel's ~4.5MB body limit, and the "too large" message tells them
// exactly what to do instead of the old silent "Upload failed".

test('cap is under Vercel body limit', () => {
  assert.ok(UPLOAD_LIMIT_BYTES < 4.5 * 1024 * 1024)
  assert.equal(UPLOAD_LIMIT_BYTES, 4 * 1024 * 1024)
})

test('too-large message states the size and the way out', () => {
  const msg = tooLargeMessage(6.2 * 1024 * 1024)
  assert.match(msg, /6\.2MB/)
  assert.match(msg, /4MB/)
  assert.match(msg, /support@youngatheart\.co\.za/)
})

test('FileTooLargeError carries the message and byte count', () => {
  const e = new FileTooLargeError(7 * 1024 * 1024)
  assert.equal(e.name, 'FileTooLargeError')
  assert.equal(e.bytes, 7 * 1024 * 1024)
  assert.match(e.message, /7\.0MB/)
})

test('doc uploads advertise the 10MB limit, small files pass through', async () => {
  const { DOC_UPLOAD_LIMIT_BYTES, tooLargeMessage: msg, prepareUploadFile } = await import('./prepare-upload')
  assert.equal(DOC_UPLOAD_LIMIT_BYTES, 10 * 1024 * 1024)
  assert.match(msg(12 * 1024 * 1024, DOC_UPLOAD_LIMIT_BYTES), /most we can upload here is 10MB/)
  const pdf = new File([new Uint8Array(8 * 1024 * 1024)], 'permit.pdf', { type: 'application/pdf' })
  assert.equal(await prepareUploadFile(pdf, DOC_UPLOAD_LIMIT_BYTES), pdf) // 8.3MB PDF now accepted
})
