// Run: node --import tsx --test src/lib/bot/vendor-memory.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readAtoms, withAtoms, renderMemory, type VendorAtom } from './vendor-memory'

test('withAtoms round-trips and preserves every other marker', () => {
  const notes = 'Priority vendor.\n⟦STALL:FS12⟧\n⟦EFT⟧\n⟦PORTAL:eyJ2IjoxfQ==⟧'
  const atoms: VendorAtom[] = [
    { fact: 'Extension to 31 Aug granted by Samreen', source: 'operator' },
    { fact: 'Can only pay by EFT', source: 'whatsapp' },
  ]
  const out = withAtoms(notes, atoms)
  // other markers untouched
  assert.match(out, /⟦STALL:FS12⟧/)
  assert.match(out, /⟦EFT⟧/)
  assert.match(out, /⟦PORTAL:eyJ2IjoxfQ==⟧/)
  assert.match(out, /Priority vendor\./)
  // atoms read back exactly
  assert.deepEqual(readAtoms(out), atoms)
})

test('withAtoms replaces its own marker, never duplicates it', () => {
  const once = withAtoms('note', [{ fact: 'a', source: 'record' }])
  const twice = withAtoms(once, [{ fact: 'b', source: 'record' }])
  assert.equal((twice.match(/⟦MEM:/g) || []).length, 1)
  assert.deepEqual(readAtoms(twice), [{ fact: 'b', source: 'record' }])
})

test('readAtoms is safe on empty / malformed', () => {
  assert.deepEqual(readAtoms(null), [])
  assert.deepEqual(readAtoms('just prose'), [])
  assert.deepEqual(readAtoms('⟦MEM:not-base64!⟧'), [])
})

test('renderMemory surfaces live state, the EFT guard, atoms and emails', () => {
  const block = renderMemory({
    business: 'Kulfi Krush', contact: 'Fathima',
    live: { status: 'approved', payment: 'deferred', amount: 4800, stall: null, dueDate: null, contractSigned: false, eftLane: false },
    atoms: [{ fact: 'Extension to 31 Aug granted by Samreen', source: 'operator' }],
    emails: [{ date: '2026-06-29', subject: 'Payment extension', snippet: 'requesting until 7 Aug, currently in Pakistan' }],
  })
  assert.match(block, /Kulfi Krush/)
  assert.match(block, /approved/)
  assert.match(block, /Extension to 31 Aug/)
  assert.match(block, /agreed by the team/) // operator source annotation
  assert.match(block, /emailed support/)

  // EFT lane vendor gets the no-bank-details guard line.
  const eft = renderMemory({
    business: 'X', contact: null,
    live: { status: 'approved', payment: 'collected', amount: 3700, stall: null, dueDate: null, contractSigned: false, eftLane: true },
    atoms: [], emails: [],
  })
  assert.match(eft, /private payment lane/i)
  assert.match(eft, /do not discuss bank details/i)
})
