import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyVendorIntent } from './vendor-brain'

// EVAL gate (ADR-004, Tier-1 pipeline). A golden set of REALISTIC vendor
// WhatsApp phrasings → expected routing. This is the regression net: it asserts
// real messages route correctly AND that ambiguous "is X" phrasings do NOT get
// mistaken for profile edits (the false-positive class). Each row: [message,
// expected kind, optional expected field].

type Field = 'website' | 'instagram' | 'facebook' | 'tagline' | 'description'
type Row = [string, string, Field?]

const GOLDEN: Row[] = [
  // --- profile edits that SHOULD route (explicit or typed value) ---
  ['set my website to https://frullato.co.za', 'update_profile', 'website'],
  ['can you change my website to www.frullato.co.za', 'update_profile', 'website'],
  ['my website is www.frullato.co.za', 'update_profile', 'website'],
  ['update my instagram to @frullato_ct', 'update_profile', 'instagram'],
  ['my instagram is @frullato', 'update_profile', 'instagram'],
  ['facebook: frullatocapetown', 'update_profile', 'facebook'],
  ['tagline: Cape Town gourmet gelato', 'update_profile', 'tagline'],
  ['set my tagline to fresh halaal gelato daily', 'update_profile', 'tagline'],
  ['update my description to artisanal halaal burgers', 'update_profile', 'description'],
  ['description = small-batch halaal chocolate', 'update_profile', 'description'],

  // --- FALSE-POSITIVE GUARD: ambiguous "is X" must NOT become a profile edit ---
  ['my website is broken', 'question'],          // not a URL → must stay a question
  ['is my website live yet?', 'question'],
  ['my instagram is down today', 'question'],     // bare word, no @ → question
  ['the description on my page is wrong', 'question'],

  // --- help / menu ---
  ['help', 'help'],
  ['what can you do', 'help'],
  ['menu', 'help'],
  // --- invoice ---
  ['send my invoice', 'get_invoice'],
  ['can I get my bill', 'get_invoice'],
  ["where's my invoice", 'get_invoice'],
  ['My invoice', 'get_invoice'],            // bare, no verb (the live gap Raeesa hit)
  ['invoice please', 'get_invoice'],
  ['I need my invoice', 'get_invoice'],
  // --- stall toggle is REMOVED (mandatory) → these are plain questions now ---
  ['publish my stall', 'question'],
  ['hide my stall', 'question'],
  ['where is my stall?', 'question'],

  // --- support notes ---
  ['note for team: I need extra power points', 'post_support'],
  ['please tell the team my fridge needs early access', 'post_support'],
  ['message for the team about parking', 'post_support'],

  // --- pay (action) vs payment questions ---
  ['I want to pay my stall fee', 'pay'],
  ['send me the payment link', 'pay'],
  ['I want to pay now', 'pay'],
  ['how do I pay?', 'question'],                  // asking HOW → question
  ['have I paid yet?', 'question'],
  ["what's my outstanding balance", 'question'],

  // --- pure questions (attendee/vendor Q&A) ---
  ['what time do gates open', 'question'],
  ['where can vendors park', 'question'],
  ['is the wifi free', 'question'],
  ['can I get more staff badges', 'question'],    // a request, but staff-add is deferred → Q&A for now
  ['thanks!', 'question'],
]

test('vendor brain golden set: realistic phrasings route correctly', () => {
  const failures: string[] = []
  for (const [msg, expectedKind, expectedField] of GOLDEN) {
    const got = classifyVendorIntent(msg)
    if (got.kind !== expectedKind) {
      failures.push(`"${msg}" → expected ${expectedKind}, got ${got.kind}`)
      continue
    }
    if (expectedField && got.kind === 'update_profile' && got.field !== expectedField) {
      failures.push(`"${msg}" → expected field ${expectedField}, got ${got.field}`)
    }
  }
  assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`)
})

test('golden set covers every action kind at least once', () => {
  const kinds = new Set<string>(GOLDEN.map(([msg]) => classifyVendorIntent(msg).kind))
  for (const k of ['question', 'help', 'update_profile', 'post_support', 'get_invoice', 'pay']) {
    assert.ok(kinds.has(k), `golden set must exercise ${k}`)
  }
})
