// One-off: send the reviewed apology messages (operator-approved 2026-08-10) via
// EMAIL (all) + WhatsApp (canSend gates it to the 24h window). Idempotent: writes
// an ⟦APOLOGISED:2026-08-10⟧ marker and skips anyone who already has it.
// DRY by default; SEND=1 to actually send.
import { config } from 'dotenv'
// .env.local ships EMPTY outbound creds (dev-safety); the real Resend + WhatsApp
// keys live in .env.production.local. Operator-authorised real send 2026-08-10.
config({ path: '.env.production.local', override: true })
import { sendText, toE164 } from '../src/lib/whatsapp'
import { sendEmail } from '../src/lib/email/resend'

const DRY = process.env.SEND !== '1'
const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const g = async (p: string) => (await fetch(`${BASE}/rest/v1/${encodeURI(p)}`, { headers: H })).json()
const PR = /⟦PORTAL:([A-Za-z0-9+/=]+)⟧/
const payStatus = (n: string) => { const m = String(n || '').match(PR); if (!m) return ''; try { return JSON.parse(Buffer.from(m[1], 'base64').toString()).payment?.status || '' } catch { return '' } }
const MARK = '⟦APOLOGISED:2026-08-10⟧'
const SUBJECT = 'Young at Heart, sorry about that payment reminder'

// match = distinctive business_name substring; wa = the message body.
const R: Array<{ match: string; wa: string }> = [
  { match: 'solo style', wa: "Hi Adnan, apologies for that email, it should not have gone out. Your arrangement to settle by 31 August 2026 stands, exactly as we said here on WhatsApp, so please ignore the overdue notice. Pay the full amount any time before 31 August through Payments in your portal. Sorry for the worry it caused." },
  { match: 'sataari', wa: "Hi Sumeez, apologies for the payment reminder that came through, it went out in error. Your arrangement to settle in full by 31 August 2026 stands, so please ignore any overdue notice. You can pay any time before then in your portal under Payments. Sorry for the confusion." },
  { match: 'exclusive hijab', wa: "Hi Shabnam, apologies for the reminder that came through, it should not have gone out. Your arrangement to pay by 31 August 2026 stands, so please ignore the overdue notice. Settle the full amount any time before then through Payments in your portal. Sorry for any confusion." },
  { match: 'wokness', wa: "Hi Seraaj, apologies for the payment reminder, it went out in error. As we said, you have until 31 August 2026 to settle in full, so please ignore any overdue message. Pay any time before then in your portal under Payments. Sorry for the confusion." },
  { match: 'flower sister', wa: "Hi Amiena, apologies for the payment reminder, it went out in error. You have until 31 August 2026 to settle in full, so please ignore any overdue notice. You can pay any time before then in your portal under Payments. Sorry for the confusion." },
  { match: 'call-a-braai', wa: "Hi Nazier, apologies for the payment reminder that came through, it should not have gone out. Your time to settle in full runs to 31 August 2026, so please ignore any overdue notice. Pay the full amount any time before then through Payments in your portal. Sorry for the confusion." },
  { match: 'confectioner', wa: "Hi Faathima, apologies for the payment reminder, it went out in error. As we said, you have until 31 August 2026 to settle in full, so please ignore any overdue notice. You can pay any time before then in your portal under Payments. Sorry for the confusion, and glad the rewiring got sorted." },
  { match: 'treacle', wa: "Hi Aakifah, apologies for the reminder that came through, it should not have gone out. Your time to pay runs to 31 August 2026 and that stands. The team is still confirming your corrected amount with the electricity included, and we will come back to you with the final figure, so please ignore any overdue notice in the meantime. Sorry for the confusion." },
  { match: 'chocotag', wa: "Hi Tasneem, apologies for the reminder that came through this morning. Your payment is received and your stall at Young at Heart is confirmed and secured, so please ignore that message, it went out in error on our side. Sorry for any worry it caused." },
  { match: 'melonscape', wa: "Hi Rabia, apologies for the payment reminder that came through this morning, that was sent in error. Your stall fee is received and your spot at Young at Heart is confirmed. Please ignore the reminder, and sorry for the confusion." },
  { match: 'koya', wa: "Hi Azhar, apologies for the payment reminder that reached you this morning, it was sent in error. Your withdrawal is noted and your application is closed, so there is nothing outstanding on your side. Sorry for any confusion, and all the best with the Daily Dippers launch. We would love to have you back at a future festival." },
]

async function main() {
  console.log(DRY ? '### DRY RUN (nothing sent) ###\n' : '### LIVE SEND ###\n')
  let emailOk = 0, waOk = 0, waSkip = 0, fail = 0
  for (const r of R) {
    // Resolve the person: prefer a row with paid_at (canonical), else the first with an email.
    const rows = await g(`vendor_applications?business_name=ilike.*${r.match}*&select=id,business_name,contact_name,phone,email,admin_notes,paid_at`)
    if (!rows.length) { console.log(`  ?? NO MATCH for "${r.match}"`); fail++; continue }
    const settled = (x: any) => !!x.paid_at || ['paid', 'collected', 'waived'].includes(payStatus(x.admin_notes))
    // Prefer the row that actually carries the payment (correct person + email
    // on a duplicate-row vendor like Melonscape), then any row with an email.
    const row = rows.find((x: any) => settled(x) && x.email) || rows.find((x: any) => x.email) || rows[0]
    const already = /⟦APOLOGISED/.test(row.admin_notes || '')
    const email = (row.email || '').trim()
    const e164 = row.phone ? (() => { try { return toE164(row.phone) } catch { return '' } })() : ''
    const emailText = `${r.wa}\n\nWarm regards,\nThe Young at Heart Festival Team`
    console.log(`• ${(row.business_name || '').trim()}  [${already ? 'ALREADY APOLOGISED, skip' : 'to send'}]`)
    console.log(`    email=${email || '(none)'}  wa=${e164 || '(none)'}`)
    if (DRY) { console.log(`    WA: "${r.wa.slice(0, 70)}..."`); continue }
    if (already) continue

    let sent = false
    if (email) {
      const er = await sendEmail({ to: email, subject: SUBJECT, text: emailText, confirmDelivery: true })
      if (er.ok) { emailOk++; sent = true; console.log(`    EMAIL sent -> ${email}`) } else { fail++; console.log(`    EMAIL FAIL -> ${email}: ${er.error}`) }
    }
    if (e164) {
      try {
        const wr = await sendText(e164, r.wa)
        if (wr.skipped) { waSkip++; console.log(`    WA skipped (${wr.skipped}) -> covered by email`) } else { waOk++; sent = true; console.log(`    WA sent -> ${e164}`) }
      } catch (e) { console.log(`    WA error: ${(e as Error).message}`) }
    }
    // Mark on the resolved row so a re-run skips (idempotent).
    if (sent) {
      const notes = (row.admin_notes || '').trim()
      const next = notes ? `${notes}\n${MARK}` : MARK
      const pr = await fetch(`${BASE}/rest/v1/vendor_applications?id=eq.${row.id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ admin_notes: next }) })
      if (!pr.ok) console.log(`    (marker write failed: ${pr.status})`)
    }
    await new Promise((res) => setTimeout(res, 400)) // gentle throttle
  }
  console.log(`\n${DRY ? 'DRY' : 'SENT'} — email:${emailOk} wa:${waOk} wa-skipped:${waSkip} fail:${fail}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
