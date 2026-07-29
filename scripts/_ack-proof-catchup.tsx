// Catch-up acknowledgement for vendors who uploaded a proof of payment BEFORE
// the upload route started acknowledging them (2026-07-29).
//
// Uses the exact same sendProofAck the route now calls, so the catch-up and the
// automatic path cannot say different things.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/_ack-proof-catchup.tsx                    # DRY RUN
//   ONLY="Aurelia" SEND=1 npx tsx --env-file=.env.local scripts/_ack-proof-catchup.tsx
//   SEND=1 npx tsx --env-file=.env.local scripts/_ack-proof-catchup.tsx             # everyone pending
//
// NOTE: run with --env-file, NOT dotenv's config(). ESM hoists imports, so the
// resend and whatsapp modules read process.env at import time, before any
// config() call in the body can populate it. That cost a failed canary today.

import { createAdminClient } from '../src/lib/supabase/admin'
import { parsePortalState } from '../src/lib/portal-state'
import { sendProofAck } from '../src/lib/payments/send-proof-ack'
import { proofAckSubject, proofAckText, proofAckWhatsApp } from '../src/lib/payments/proof-ack'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()

async function main() {
  const db = createAdminClient()
  const { data, error } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at')
    .limit(1000)
  if (error) { console.error('QUERY FAILED:', error.message); process.exit(1) }

  let rows = (data || []).filter((r) => {
    const p = parsePortalState(r.admin_notes as string).payment
    // Uploaded a proof, and it has not been reconciled to a real settlement yet.
    return !!p?.eft_submitted_at && !r.paid_at && p?.status !== 'paid'
  })
  if (ONLY) rows = rows.filter((r) => String(r.business_name || '').trim().toLowerCase() === ONLY)

  console.log(`\n${DRY ? 'DRY RUN, nothing sent' : 'LIVE SEND'} — ${rows.length} vendor(s) with an unreconciled proof\n${'='.repeat(64)}`)

  let ok = 0
  for (const r of rows) {
    const biz = String(r.business_name || '').trim()
    const first = String(r.contact_name || 'there').trim().split(/\s+/)[0]
    console.log(`\n### ${biz}  (${first}, ${r.email || 'no email'}, ${r.phone || 'no phone'})`)
    if (DRY) {
      console.log(`  SUBJECT: ${proofAckSubject(biz)}`)
      console.log(`  ---8<--- EMAIL ---8<---\n${proofAckText(first, biz)}`)
      console.log(`  ---8<--- WHATSAPP ---8<---\n${proofAckWhatsApp(biz)}`)
      continue
    }
    const res = await sendProofAck({
      businessName: biz,
      contactName: r.contact_name as string | null,
      email: r.email as string | null,
      phone: r.phone as string | null,
    })
    console.log(`  email=${res.email} whatsapp=${res.whatsapp}${res.errors.length ? ` errors=${JSON.stringify(res.errors)}` : ''}`)
    if (res.email || res.whatsapp) ok++
    await new Promise((s) => setTimeout(s, 300))
  }
  console.log(`\n${'='.repeat(64)}\n${DRY ? 'DRY RUN complete' : `reached ${ok} of ${rows.length}`}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
