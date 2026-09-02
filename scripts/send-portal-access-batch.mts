/**
 * Send a working portal link to approved vendors who have NEVER signed in.
 * Authorised by Taona 2026-07-27: 75 approved vendors got the WhatsApp approval
 * (which promises a link "shortly" and never sends one) and never got into the
 * portal. Sulaimaan was one of them, and his address was silently suppressed.
 *
 * Mirrors /api/exhibitor/send-password-reset exactly, but server-side: that
 * endpoint throttles 5 per IP per 10 minutes, so 75 calls from one machine would
 * be silently dropped after the fifth.
 *
 * RESUMABLE and honest: every send is confirmed with Resend, every result is
 * printed, and a suppressed or bouncing address is reported rather than counted
 * as success. --limit to cap a run, --dry to list without sending.
 */
import { createClient } from '@supabase/supabase-js'
import { sendEmail } from '../src/lib/email/resend'
import { PasswordReset } from '../src/lib/email/templates/PasswordReset'

const DRY = process.argv.includes('--dry')
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0) || Infinity
const ORIGIN = 'https://cthalaal.co.za'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } })

const { data: apps } = await db.from('vendor_applications')
  .select('id, business_name, contact_name, email, admin_notes').eq('status', 'approved')
const live = (apps || []).filter((a) => !/⟦MERGED:/.test((a.admin_notes as string) || ''))

const { data: list } = await db.auth.admin.listUsers({ perPage: 2000 })
const byEmail = new Map((list.users || []).map((u) => [(u.email || '').toLowerCase(), u]))

const targets = live.filter((a) => {
  const u = byEmail.get((a.email || '').toLowerCase())
  return u && !u.last_sign_in_at
}).slice(0, LIMIT)

console.log(`${targets.length} approved vendors have never signed in${DRY ? ' (dry run, sending nothing)' : ''}\n`)

let sent = 0, failed = 0
for (const a of targets) {
  const email = String(a.email || '').trim()
  const name = (a.business_name || a.contact_name || '').trim()
  if (DRY) { console.log(`  would send -> ${name.padEnd(30)} ${email}`); continue }

  const { data, error } = await db.auth.admin.generateLink({ type: 'recovery', email })
  const hashed = data?.properties?.hashed_token
  const vtype = data?.properties?.verification_type
  if (error || !hashed || !vtype) {
    failed++; console.log(`  LINK FAILED  ${name.padEnd(30)} ${email}  ${error?.message || 'no token'}`); continue
  }
  const resetUrl = `${ORIGIN}/auth/callback?${new URLSearchParams({ token_hash: hashed, type: vtype, next: '/exhibitor/set-password' })}`
  const res = await sendEmail({
    to: email,
    subject: 'Your Young at Heart Festival exhibitor portal access',
    react: PasswordReset({ resetUrl, contactName: name || undefined }),
    text: `Hi ${name || 'there'},\n\nHere is your link to set a password and get into your Young at Heart Festival exhibitor portal (expires in 1 hour):\n\n${resetUrl}\n\nOnce you are in you can see your stall fee, pay it, upload documents and add staff.\n\nWarm regards,\nThe Young at Heart Festival Team`,
    confirmDelivery: true,   // a suppressed address must surface, not vanish
  })
  if (res?.ok) { sent++; console.log(`  sent         ${name.padEnd(30)} ${email}`) }
  else { failed++; console.log(`  NOT DELIVERED ${name.padEnd(29)} ${email}  ${res?.error || 'unknown'}`) }
  await new Promise((r) => setTimeout(r, 700))   // Resend allows 2/sec
}

console.log(`\ndelivered ${sent}, failed ${failed}, of ${targets.length}`)
