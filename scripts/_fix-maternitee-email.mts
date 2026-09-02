// MaterniTee (Raeesa Jenkins) could not log in from 19 June to 29 July because
// her email was captured with a typo: raeesajenkjns@ instead of raeesajenkins@,
// a j where the i belongs.
//
// Every password reset was sent successfully to an address that does not exist,
// so the bot truthfully reported "sent" while she received nothing. Her auth
// user was created under the typo and last_sign_in_at is NEVER.
//
// She confirmed the correct address herself, unprompted, from the phone number
// on her application (+27824305318 vs 0824305318 on file), so identity is not
// in question here.
//
// Fixes BOTH sides. Correcting only the application row would leave the auth
// account on the dead address and she still could not log in; correcting only
// auth would leave every future email going to the typo.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/_fix-maternitee-email.mts          # DRY
//   APPLY=1 npx tsx --env-file=.env.local scripts/_fix-maternitee-email.mts

import { createAdminClient } from '../src/lib/supabase/admin'

const APPLY = process.env.APPLY === '1'
const WRONG = 'raeesajenkjns@gmail.com'
const RIGHT = 'raeesajenkins@gmail.com'

async function main() {
  const db = createAdminClient()

  const { data: apps, error } = await db
    .from('vendor_applications')
    .select('id, business_name, email, phone')
    .ilike('email', WRONG)
  if (error) { console.error('QUERY FAILED:', error.message); process.exit(1) }
  if (!apps?.length) { console.log('No application on the typo address. Already fixed?'); return }
  if (apps.length > 1) { console.error(`REFUSING: ${apps.length} applications share that address.`); process.exit(1) }

  const app = apps[0] as { id: string; business_name: string; email: string; phone: string }
  console.log(`application : ${app.business_name} (${app.phone})`)
  console.log(`  email     : ${app.email}  ->  ${RIGHT}`)

  const { data: list } = await (db as never as { auth: { admin: { listUsers(o: unknown): Promise<{ data?: { users?: { id: string; email?: string; last_sign_in_at?: string }[] } }> } } })
    .auth.admin.listUsers({ page: 1, perPage: 1000 })
  const user = (list?.users || []).find((u) => String(u.email || '').toLowerCase() === WRONG)
  console.log(`auth user   : ${user ? `${user.email} (last sign-in ${user.last_sign_in_at || 'NEVER'})` : 'NOT FOUND'}`)

  // Guard: refuse if the correct address is already taken by a different
  // account, which would silently merge two vendors.
  const clash = (list?.users || []).find((u) => String(u.email || '').toLowerCase() === RIGHT)
  if (clash && clash.id !== user?.id) { console.error(`REFUSING: ${RIGHT} already belongs to another auth user.`); process.exit(1) }

  if (!APPLY) { console.log('\nDRY RUN. Re-run with APPLY=1 to write.'); return }

  const { error: upErr } = await db.from('vendor_applications').update({ email: RIGHT }).eq('id', app.id)
  if (upErr) { console.error('application update FAILED:', upErr.message); process.exit(1) }
  console.log('application email updated')

  if (user) {
    const admin = (db as never as { auth: { admin: { updateUserById(id: string, a: unknown): Promise<{ error?: { message: string } }> } } }).auth.admin
    // email_confirm so she is not forced through a fresh confirmation step on
    // top of a reset she has already been waiting five weeks for.
    const { error: auErr } = await admin.updateUserById(user.id, { email: RIGHT, email_confirm: true })
    if (auErr) { console.error('auth update FAILED:', auErr.message); process.exit(1) }
    console.log('auth user email updated')
  }

  // Now the reset can actually arrive. confirmDelivery lives inside this
  // endpoint, so a second failure would be logged rather than silent.
  const res = await fetch('https://cthalaal.co.za/api/exhibitor/send-password-reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: RIGHT }),
  })
  console.log(`password reset requested: HTTP ${res.status}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
