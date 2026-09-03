import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactNotesForViewer, mergeNotesFromViewer } from './eft'

// The festival owner (Samreen) is not an EFT admin; taona@ is (EFT_ADMIN_EMAILS).
const OWNER = 'capetownhalaal@gmail.com'
const EFT_ADMIN = 'taona@cthalaal.co.za'

// A real covert master-lane vendor's admin_notes: human prose + a stall
// allocation the owner legitimately sees, plus the covert EFT lane marker,
// the owner-visibility flag, and the base64 payment blob she must never see.
const PORTAL = '⟦PORTAL:eyJwYXltZW50Ijp7InN0YXR1cyI6ImNvbGxlY3RlZCIsIm1ldGhvZCI6ImVmdCJ9fQ==⟧'
const NOTES = `Lovely vendor, wants a corner spot.\n⟦STALL:A12⟧\n⟦EFT⟧\n⟦OWNERVIS⟧\n${PORTAL}`

test('the owner never sees the covert EFT / PORTAL / OWNERVIS markers', () => {
  const red = redactNotesForViewer(NOTES, OWNER) as string
  assert.ok(!red.includes('⟦EFT⟧'), 'EFT lane marker hidden')
  assert.ok(!red.includes('⟦OWNERVIS⟧'), 'ownervis marker hidden')
  assert.ok(!red.includes('⟦PORTAL'), 'base64 payment blob hidden')
  assert.ok(red.includes('⟦STALL:A12⟧'), 'stall allocation stays visible to her')
  assert.ok(red.includes('Lovely vendor'), 'human prose stays')
})

test('the EFT admin reads the raw admin_notes untouched', () => {
  assert.equal(redactNotesForViewer(NOTES, EFT_ADMIN), NOTES)
})

test('a redacted read then owner save re-attaches the covert markers (no data loss)', () => {
  const red = redactNotesForViewer(NOTES, OWNER) as string   // what the owner loads
  const edited = `${red}\nAsked about setup time.`           // she edits the human text
  const merged = mergeNotesFromViewer(edited, NOTES, OWNER)   // saved back
  assert.ok(merged.includes('⟦EFT⟧'), 'EFT lane marker survives her save')
  assert.ok(merged.includes('⟦PORTAL'), 'payment blob survives her save')
  assert.ok(merged.includes('⟦OWNERVIS⟧'))
  assert.ok(merged.includes('⟦STALL:A12⟧'))
  assert.ok(merged.includes('Asked about setup time.'), 'her edit is kept')
})

test('the EFT admin save writes exactly what they submitted', () => {
  assert.equal(mergeNotesFromViewer('rewrote the whole note', NOTES, EFT_ADMIN), 'rewrote the whole note')
})

test('a vendor with no covert markers round-trips cleanly, no spurious tokens', () => {
  const plain = 'Just a normal note.\n⟦STALL:B3⟧'
  assert.equal(redactNotesForViewer(plain, OWNER), plain)
  assert.equal(mergeNotesFromViewer('Just a normal note.\n⟦STALL:B3⟧', plain, OWNER), plain)
})

test('null / empty pass through safely', () => {
  assert.equal(redactNotesForViewer(null, OWNER), null)
  assert.equal(redactNotesForViewer(undefined, OWNER), undefined)
  assert.equal(mergeNotesFromViewer('', null, OWNER), '')
})
