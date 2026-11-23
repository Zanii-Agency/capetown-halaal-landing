#!/usr/bin/env node
// Festival brain grounding eval — Nisria/Sasa-style.
// Hits the LIVE /api/chat and checks the bot answers accurately AND never
// invents. Run: node eval/festival-brain-eval.mjs  [baseUrl]
// Default baseUrl = https://cthalaal.co.za

const BASE = process.argv[2] || 'https://cthalaal.co.za'

// Each case: a question, substrings that MUST appear (grounded fact), and
// substrings that must NOT appear (hallucination guards).
const CASES = [
  { q: 'How much is a weekend pass?', must: ['R100'], mustNot: [] },
  { q: 'How much is a day ticket?', must: ['R40'], mustNot: [] },
  { q: 'Where is the festival held?', must: ['Youngsfield'], mustNot: [] },
  { q: 'What dates is the festival?', must: ['11', '13', 'December'], mustNot: [] },
  { q: 'Is the food halaal?', must: ['halaal'], mustNot: [] },
  { q: 'How much for a 3x3 food stall?', must: ['4,800'], mustNot: [] },
  // Hallucination guards: the bot must defer, not invent.
  { q: 'Can I get a refund on my ticket?', must: ['support@youngatheart.co.za', 'get'], mustNot: ['refund policy is', '7 days', '14 days', '30 day'] },
  { q: 'What exact rides and brands of rides will be there?', must: [], mustNot: ['Ferris wheel will', 'roller coaster', 'specifically these rides'], deferExpected: true },
  { q: 'What time exactly do gates close each night?', must: [], mustNot: ['closes at 10', 'closes at 11', 'closes at 9pm'], deferExpected: true },
]

const DEFER_SIGNALS = ['support@youngatheart.co.za', "don't have", 'not sure', 'confirmed closer', 'reach out', 'instagram', 'check', 'get samreen on this', 'will reply']

async function ask(q) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: q }] }),
  })
  const d = await res.json()
  return d.message || d.reply || ''
}

let pass = 0, fail = 0
for (const c of CASES) {
  // Rate limit: wait 6s between requests to avoid bot throttling
  await new Promise(r => setTimeout(r, 6000))
  let reply = ''
  try { reply = await ask(c.q) } catch (e) { console.log(`❌ ${c.q}\n   request failed: ${e}`); fail++; continue }
  const low = reply.toLowerCase()
  const missing = c.must.filter((m) => !low.includes(m.toLowerCase()))
  const leaked = (c.mustNot || []).filter((m) => low.includes(m.toLowerCase()))
  const deferOk = !c.deferExpected || DEFER_SIGNALS.some((s) => low.includes(s.toLowerCase()))
  const ok = missing.length === 0 && leaked.length === 0 && deferOk
  if (ok) { pass++; console.log(`✅ ${c.q}`) }
  else {
    fail++
    console.log(`❌ ${c.q}`)
    if (missing.length) console.log(`   missing: ${missing.join(', ')}`)
    if (leaked.length) console.log(`   HALLUCINATION leaked: ${leaked.join(', ')}`)
    if (!deferOk) console.log(`   expected to defer/route to support but didn't`)
    console.log(`   reply: ${reply.slice(0, 160)}…`)
  }
}
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
