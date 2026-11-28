// BACKFILL outbound support-inbox rows whose body is '' (not just NULL), 2026-10-01.
//
// backfill-blank-outbound-bodies.mts only wrote rows where body_text IS NULL, so
// rows the webhook stored as '' stayed subject-only. This selects ids of empty
// rows (text AND html null or ''), fetches each from Resend, and updates BY ID.
// Silent: reads Resend, writes Supabase, never sends anything.
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/backfill-empty-outbound-bodies.mts --dry
//   node --env-file=.env.local --import tsx scripts/backfill-empty-outbound-bodies.mts
import { createAdminClient } from '@/lib/supabase/admin'

const DRY = process.argv.includes('--dry')
const KEY = process.env.RESEND_API_KEY
if (!KEY) throw new Error('RESEND_API_KEY missing')
const db = createAdminClient()

// Select ALL ids first (paged, PostgREST caps at 1000), then update by id.
const rows: Array<{ id: string; provider_message_id: string }> = []
for (let off = 0; ; off += 1000) {
  const { data, error } = await db
    .from('support_inbox_messages')
    .select('id, provider_message_id')
    .eq('direction', 'out')
    .eq('provider', 'resend')
    .not('provider_message_id', 'is', null)
    .or('body_text.is.null,body_text.eq.')
    .or('body_html.is.null,body_html.eq.')
    .order('id')
    .range(off, off + 999)
  if (error) throw new Error(error.message)
  rows.push(...((data || []) as typeof rows))
  if (!data || data.length < 1000) break
}
console.log(`selected ${rows.length}`)
console.log(rows.map((r) => r.id).join('\n'))
// Resend keeps bodies ~30 days; older ids 404 and are reported, not faked.
if (DRY) process.exit(0)

let updated = 0
const missing: string[] = []
for (const r of rows) {
  const res = await fetch(`https://api.resend.com/emails/${r.provider_message_id}`, { headers: { Authorization: `Bearer ${KEY}` } })
  const j = res.ok ? ((await res.json()) as { text?: string | null; html?: string | null }) : null
  const text = (j?.text || '').trim() || null
  const html = (j?.html || '').trim() || null
  if (!text && !html) { missing.push(`${r.id} (http ${res.status})`); continue }
  const { error: upErr, count } = await db
    .from('support_inbox_messages')
    .update({ body_text: text, body_html: html }, { count: 'exact' })
    .eq('id', r.id)
  if (upErr) { missing.push(`${r.id} (${upErr.message})`); continue }
  updated += count || 0
  await new Promise((ok) => setTimeout(ok, 120)) // Resend rate limit ~10 rps
}
console.log(`updated ${updated} / selected ${rows.length}`)
if (missing.length) console.log(`not filled:\n${missing.join('\n')}`)
if (updated !== rows.length) { console.error('ASSERT FAILED: updated != selected'); process.exit(1) }
