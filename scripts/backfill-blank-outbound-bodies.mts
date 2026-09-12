// BACKFILL blank outbound support-inbox bodies from Resend (Taona 2026-09-12).
//
// Operator replies showed as empty bubbles because the Resend `email.sent`
// webhook writes a body-less row and, on a message_id mismatch, the sender's own
// log row never backfilled it. Resend keeps ~30 days of email bodies, so we pull
// the real text back and write it into any row STILL blank. Only writes to blank
// rows, never overwrites a body that exists. Idempotent, resumable.
//
// FAST: fetches ONLY the blank rows we need (not Resend's whole list), in
// parallel batches. Windowed to received_at >= WINDOW_START because Resend drops
// bodies older than ~30 days (a get on those 404s and wastes a round-trip).
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/backfill-blank-outbound-bodies.mts --dry
//   node --env-file=.env.local --import tsx scripts/backfill-blank-outbound-bodies.mts
import { createAdminClient } from '@/lib/supabase/admin'
import { Resend } from 'resend'

const DRY = process.argv.includes('--dry')
const WINDOW_START = '2026-08-13' // Resend retention floor (verified ~14 Aug)
const CONC = 20
const db = createAdminClient()
const resend = new Resend(process.env.RESEND_API_KEY || '')

// 1. Blank outbound rows in the recoverable window, with a provider id to fetch.
const rows: Array<{ id: string; pid: string }> = []
let off = 0
for (;;) {
  const { data } = await db
    .from('support_inbox_messages')
    .select('id, provider_message_id, received_at')
    .eq('direction', 'out')
    .or('body_text.is.null,body_text.eq.')
    .not('provider_message_id', 'is', null)
    .gte('received_at', WINDOW_START)
    .range(off, off + 999)
  if (!data?.length) break
  for (const r of data) rows.push({ id: r.id as string, pid: r.provider_message_id as string })
  if (data.length < 1000) break
  off += 1000
}
console.log(`blank rows in window (>= ${WINDOW_START}): ${rows.length}`)

// 2. Fetch bodies from Resend in parallel batches; write each as it resolves.
let filled = 0, gone = 0, errs = 0
for (let i = 0; i < rows.length; i += CONC) {
  const batch = rows.slice(i, i + CONC)
  await Promise.all(batch.map(async (row) => {
    try {
      const full = await resend.emails.get(row.pid)
      const body = (full.data?.text || '').trim()
      if (!body) { gone++; return }
      if (!DRY) await db.from('support_inbox_messages').update({ body_text: body }).eq('id', row.id).is('body_text', null)
      filled++
    } catch { errs++ }
  }))
  if ((i / CONC) % 10 === 0) console.log(`  …${i + batch.length}/${rows.length} (filled ${filled}, no-body ${gone}, err ${errs})`)
}
console.log(`${DRY ? 'DRY' : 'WRITE'} — filled ${filled}; no body in Resend ${gone}; errors ${errs}`)
