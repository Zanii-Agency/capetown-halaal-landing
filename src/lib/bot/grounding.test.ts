import { test } from 'node:test'
import assert from 'node:assert/strict'
import { systemPrompt } from './vendor-agent'
import { pendingRequestsLine } from './tools/registry'
import type { VendorSession } from './vendor-session'

// REGRESSION GUARD. The live WhatsApp brain is vendor-agent.ts (CTH_AGENT on),
// NOT festival-brain's BASE_PROMPT. The part-payment / documents grounding
// existed only in BASE_PROMPT, so the tested prompt and the served prompt were
// different files: the 31-Aug policy never reached a vendor. These assert the
// grounding is on the prompt that actually ships.

const verified: VendorSession = { status: 'verified', waPhone: '+27821234567', vendorId: 'v1' } as VendorSession
const unknown: VendorSession = { status: 'unknown', waPhone: '+27821234567' } as VendorSession

test('verified vendor prompt carries the part-payment 31-August policy', () => {
  const p = systemPrompt(verified)
  assert.match(p, /31 August 2026/)
  assert.match(p, /actually solve it with your tools/) // solve-don't-deflect discipline
})

test('persona: support person, not a robot; no ticket-buyer payment line for vendors', () => {
  const p = systemPrompt(verified)
  assert.match(p, /support person for the Young at Heart Festival/)
  assert.match(p, /Wa alaikum assalam/)               // keeps the Islamic warmth
  assert.match(p, /cash at the event/)                // the guard AGAINST saying it to vendors
  assert.match(p, /card-in-the-portal only/)
})

test('EFT nuance: legit organisation exception, but no for an ordinary individual', () => {
  const p = systemPrompt(verified)
  assert.match(p, /genuine ORGANISATION/)
  assert.match(p, /does not use credit cards/)
  assert.match(p, /ordinary individual who just prefers EFT/)
  assert.match(p, /arrange EFT for them/)
})

test('verified vendor prompt carries operational facts (documents, allocation)', () => {
  const p = systemPrompt(verified)
  assert.match(p, /Halaal Certificate/)
  assert.match(p, /Stall allocation happens closer to the festival/)
})

test('prompt carries the three conservative policies (discount, sharing, withdrawal)', () => {
  const p = systemPrompt(verified)
  assert.match(p, /do not discount, negotiate, or price-match/)
  assert.match(p, /cannot split or share a single stall/)
  assert.match(p, /NEVER quote, promise, or estimate a refund/)
})

test('unverified sender does NOT get operational facts or prices', () => {
  const p = systemPrompt(unknown)
  assert.doesNotMatch(p, /Halaal Certificate/)
  assert.doesNotMatch(p, /R3,700/)
})

test('pendingRequestsLine surfaces an open escalation so the bot never says "no request on file"', () => {
  const line = pendingRequestsLine({
    v: 1,
    support: [{ id: 'x', from: 'vendor', body: 'wants to pay half now, rest end of August', at: '2026-07-19T16:07:00Z' }],
  })
  assert.match(line, /already logged with the team/)
  assert.match(line, /2026-07-19/)
})

test('pendingRequestsLine surfaces a pending stall-size change', () => {
  const line = pendingRequestsLine({
    v: 1,
    stallChangeRequest: { requestedTier: '4x2m double table', currentTier: '2x2m', reason: 'x', status: 'pending', createdAt: '2026-07-20T00:00:00Z' },
  })
  assert.match(line, /pending stall-size change/)
})

test('pendingRequestsLine is empty when nothing is open (admin already replied)', () => {
  const line = pendingRequestsLine({
    v: 1,
    support: [
      { id: 'a', from: 'vendor', body: 'q', at: '2026-07-19T16:07:00Z' },
      { id: 'b', from: 'admin', body: 'answered', at: '2026-07-19T18:00:00Z' },
    ],
  })
  assert.equal(line, '')
})
