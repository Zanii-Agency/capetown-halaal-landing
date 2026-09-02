// WhatsApp the approved vendors who have NEVER signed in to the portal.
// Taona 2026-07-29: "message them via whatsapp".
//
// NOT A PAYMENT CHASE. This is about ACCESS. 55 approved vendors have never
// once logged in, some since 13 June, and until today we had no idea whether
// that was apathy or lockout. Raeesa Jenkins turned out to be locked out by a
// one-letter typo in her email, silently, for five weeks.
//
// THE MESSAGE CARRIES THEIR OWN EMAIL ADDRESS BACK TO THEM.
//
// That is the whole design. A typo is invisible from our side and obvious from
// theirs, so showing each vendor the address we hold turns 40 messages into 40
// self-diagnosing checks. Nobody has to be probed, and no resets are blasted.
// The reply path is live: the bot now detects an undeliverable reset, names the
// address, and can repair both records itself.
//
// EXCLUSIONS, MEASURED NOT ASSUMED:
//   15 of the 55 were already messaged TODAY by the overdue chase. Contacting
//      them again tonight would be a third touch in one day.
//    0 have no phone on file.
//   Leaves 40. One of them has already paid; the copy is about access only, so
//   it reads correctly for them too.
//
// NO PAYMENT METHOD IS NAMED. Global EFT mode is on and most of this cohort is
// on the lane, so the portal decides what they see, not this message.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/_nudge-never-logged-in.tsx              # DRY
//   ONLY="kidsROCK" SEND=1 npx tsx --env-file=.env.local scripts/_nudge-never-logged-in.tsx
//   SEND=1 npx tsx --env-file=.env.local scripts/_nudge-never-logged-in.tsx

import { createAdminClient } from '../src/lib/supabase/admin'
import { parsePortalState } from '../src/lib/portal-state'
import { sendTemplate, toE164 } from '../src/lib/whatsapp'

const DRY = process.env.SEND !== '1'
const ONLY = (process.env.ONLY || '').trim().toLowerCase()
const LOGIN = 'cthalaal.co.za/exhibitor/login'

// festival_announcement renders "Hi {{1}}! {{2}}", so {{2}} must not greet.
// Law 7: commas and periods, never a long dash.
function body(email: string) {
  return (
    `You have not signed in to your Young at Heart exhibitor portal yet. ` +
    `That is where your stall details, documents and payment all live, so it is worth a few minutes. ` +
    `Sign in at ${LOGIN} using this email address: ${email}. ` +
    `If that address is wrong, or you cannot get in, reply here and we will sort it out for you straight away.`
  )
}

async function main() {
  const db = createAdminClient()

  const users: { email?: string; last_sign_in_at?: string }[] = []
  for (let page = 1; page <= 6; page++) {
    const { data } = await (db as never as { auth: { admin: { listUsers(o: unknown): Promise<{ data?: { users?: typeof users } }> } } })
      .auth.admin.listUsers({ page, perPage: 1000 })
    const u = data?.users || []
    users.push(...u)
    if (u.length < 1000) break
  }
  const byEmail = new Map(users.map((u) => [String(u.email || '').toLowerCase(), u]))

  const rows: Record<string, unknown>[] = []
  for (let p = 0; p < 25; p++) {
    const { data, error } = await db.from('vendor_applications')
      .select('id, business_name, contact_name, email, phone, status, admin_notes')
      .order('id').range(p * 1000, p * 1000 + 999)
    if (error) { console.error('QUERY FAILED:', error.message); process.exit(1) }
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }

  const today = new Date().toISOString().slice(0, 10)
  let list = rows.filter((r) => {
    if (r.status !== 'approved') return false
    const u = byEmail.get(String(r.email || '').toLowerCase())
    if (!u || u.last_sign_in_at) return false          // never signed in only
    if (!r.phone) return false                          // WhatsApp needs a number
    const st = parsePortalState(r.admin_notes as string) as unknown as { payment_reminders?: { history?: { at: string }[] } }
    const hist = st.payment_reminders?.history || []
    if (hist.some((h) => String(h.at).slice(0, 10) === today)) return false  // already hit today
    return true
  })
  if (ONLY) list = list.filter((r) => String(r.business_name || '').trim().toLowerCase() === ONLY)

  console.log(`\n${DRY ? 'DRY RUN, nothing sent' : 'LIVE SEND'} — ${list.length} vendor(s)\n${'='.repeat(64)}`)

  let ok = 0
  const fails: string[] = []
  for (const r of list) {
    const biz = String(r.business_name || '').trim()
    const first = String(r.contact_name || 'there').trim().split(/\s+/)[0] || 'there'
    // The phone column sometimes holds two numbers. Take the first.
    const phone = String(r.phone || '').split(/[\/,;]/)[0].trim()
    const msg = body(String(r.email || ''))

    console.log(`\n### ${biz} (${first}, ${phone})`)
    console.log(`  Hi ${first}! ${msg}`)
    if (DRY) continue

    try {
      const res = await sendTemplate(toE164(phone), 'festival_announcement', [first, msg], { category: 'utility' })
      if (res.skipped) fails.push(`${biz}: ${res.skipped}`)
      else { ok++; console.log('  sent') }
    } catch (e) { fails.push(`${biz}: ${(e as Error).message}`) }
    await new Promise((s) => setTimeout(s, 300))
  }

  console.log(`\n${'='.repeat(64)}\n${DRY ? 'DRY RUN complete' : `sent ${ok} of ${list.length}`}`)
  if (fails.length) { console.log(`\n${fails.length} problem(s):`); fails.forEach((f) => console.log(`  ${f}`)) }
}

main().catch((e) => { console.error(e); process.exit(1) })
