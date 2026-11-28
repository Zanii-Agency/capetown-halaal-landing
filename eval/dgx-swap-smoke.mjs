#!/usr/bin/env node
// Standalone smoke test for the DGX swap: hits the dgx endpoint directly with
// the real FESTIVAL_SYSTEM_PROMPT and replays a subset of the festival-brain
// eval cases. Validates the dgx.ts code shape (request format, response
// parsing) and a rough quality floor.
//
// Usage:
//   DGX_ENDPOINT=http://127.0.0.1:8004/v1 \
//   DGX_API_KEY=sk-... \
//   DGX_MODEL_NAME=uncensored-70b \
//   node eval/dgx-swap-smoke.mjs

const { FESTIVAL_SYSTEM_PROMPT } = await import('../src/lib/festival-brain.ts').catch(async () => {
  // Fallback: read the prompt straight from the file as a string. This runs
  // before tsx is set up, so use a regex grab.
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/lib/festival-brain.ts', 'utf8')
  const m = src.match(/FESTIVAL_SYSTEM_PROMPT = `([\s\S]+?)`/)
  if (!m) throw new Error('could not extract FESTIVAL_SYSTEM_PROMPT')
  return { FESTIVAL_SYSTEM_PROMPT: m[1] }
})

const ENDPOINT = process.env.DGX_ENDPOINT
const KEY = process.env.DGX_API_KEY
const MODEL = process.env.DGX_MODEL_NAME
if (!ENDPOINT || !KEY || !MODEL) {
  console.error('missing DGX_ENDPOINT / DGX_API_KEY / DGX_MODEL_NAME')
  process.exit(1)
}

const CASES = [
  { q: 'How much is a weekend pass?', must: ['R100'], mustNot: [] },
  { q: 'How much is a day ticket?', must: ['R40'], mustNot: [] },
  { q: 'Where is the festival held?', must: ['Youngsfield'], mustNot: [] },
  { q: 'What dates is the festival?', must: ['11', '13', 'December'], mustNot: [] },
  { q: 'Is the food halaal?', must: ['halaal'], mustNot: [] },
  { q: 'How much for a 3x3 food stall?', must: ['4,800'], mustNot: [] },
  { q: 'Can I get a refund on my ticket?', must: ['support@youngatheart.co.za'], mustNot: ['refund policy is', '7 days', '14 days', '30 day'] },
  { q: 'What exact rides and brands of rides will be there?', must: [], mustNot: ['Ferris wheel will', 'roller coaster will be', 'specifically these rides'], deferExpected: true },
  { q: 'What time exactly do gates close each night?', must: [], mustNot: ['closes at 10', 'closes at 11', 'closes at 9pm'], deferExpected: true },
]

const DEFER_SIGNALS = ['support@youngatheart.co.za', "don't have", 'not sure', 'confirmed closer', 'reach out', 'instagram', 'check']

async function ask(question) {
  const res = await fetch(`${ENDPOINT.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: FESTIVAL_SYSTEM_PROMPT },
        { role: 'user', content: question },
      ],
      max_tokens: 300,
      temperature: 0.4,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

let pass = 0, fail = 0
for (const c of CASES) {
  let reply = ''
  try { reply = await ask(c.q) } catch (e) {
    console.log(`FAIL  ${c.q}\n      request error: ${e.message}\n`); fail++; continue
  }
  const low = reply.toLowerCase()
  const missing = c.must.filter((m) => !low.includes(m.toLowerCase()))
  const leaked = c.mustNot.filter((m) => low.includes(m.toLowerCase()))
  const deferred = c.deferExpected ? DEFER_SIGNALS.some((s) => low.includes(s.toLowerCase())) : true
  const ok = missing.length === 0 && leaked.length === 0 && deferred
  if (ok) { pass++; console.log(`PASS  ${c.q}\n      reply: ${reply.slice(0, 140).replace(/\n/g, ' ')}\n`) }
  else { fail++; console.log(`FAIL  ${c.q}\n      reply: ${reply.slice(0, 220).replace(/\n/g, ' ')}\n      missing: ${missing.join(', ')||'-'}  leaked: ${leaked.join(', ')||'-'}  deferred: ${deferred}\n`) }
}
console.log(`\nResult: ${pass}/${pass+fail} passed against model=${MODEL}`)
process.exit(fail === 0 ? 0 : 1)
