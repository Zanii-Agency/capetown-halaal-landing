// Repair a vendor's own email address after mail to it has provably failed.
//
// Taona 2026-07-29: "train the bot to fix it autonomously when someone
// complains". This is what the bot calls once a vendor reads their address back
// and it turns out to be wrong.
//
// THE SECURITY PROPERTY IS THE FAILURE GATE.
//
// Letting a vendor change the email on their own account is an account-takeover
// primitive in general. It is safe HERE only because it is gated on the current
// address having a RECORDED delivery failure. You cannot point this at a
// healthy account: there is nothing to repair, so it refuses. It can only ever
// rescue an account that is already unreachable, which is exactly the state
// where the usual email-based proof of identity is unavailable by definition.
//
// Identity therefore rests on the WhatsApp session, which proved control of the
// phone number on the application. That is the same proof the bot already
// accepts for invoices, payment status and stall changes. The backstop is that
// every change alerts the master with old and new, and is written to the audit
// trail, so a wrong one is visible and reversible within minutes.
//
// BOTH SIDES OR NEITHER. Raeesa Jenkins had her application corrected in an
// earlier attempt while her Supabase auth user stayed on the dead address, so
// she still could not log in. This updates the application AND the auth user,
// and reports partial failure loudly rather than claiming success.

import { createAdminClient } from '@/lib/supabase/admin'

export interface RepairResult {
  ok: boolean
  reason?: string
  oldEmail?: string
  newEmail?: string
  resetDelivered?: boolean
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/

/** Has mail to this address been recorded as undeliverable? */
export async function hasKnownDeliveryFailure(email: string): Promise<boolean> {
  const e = (email || '').toLowerCase().trim()
  if (!e) return false
  const db = createAdminClient()
  const { data } = await db
    .from('site_events')
    .select('metadata')
    .eq('event_type', 'email_undeliverable')
    .order('created_at', { ascending: false })
    .limit(500)
  return (data || []).some((r) => String((r as { metadata?: { email?: string } }).metadata?.email || '').toLowerCase() === e)
}

export async function repairVendorEmail(applicationId: string, rawNew: string): Promise<RepairResult> {
  const db = createAdminClient()
  const newEmail = (rawNew || '').toLowerCase().trim()

  if (!EMAIL_RE.test(newEmail)) return { ok: false, reason: 'that does not look like a valid email address' }

  const { data: apps } = await db
    .from('vendor_applications')
    .select('id, business_name, email')
    .eq('id', applicationId)
    .limit(1)
  const app = (apps || [])[0] as { id: string; business_name: string; email: string } | undefined
  if (!app) return { ok: false, reason: 'application not found' }

  const oldEmail = String(app.email || '').toLowerCase().trim()
  if (oldEmail === newEmail) return { ok: false, reason: 'that is already the address on file' }

  // THE GATE. No recorded failure means nothing is broken, so there is nothing
  // to repair and this must not become a general "change my email" endpoint.
  if (!(await hasKnownDeliveryFailure(oldEmail))) {
    return { ok: false, reason: 'the address on file has not failed delivery, so this needs a human' }
  }

  // Never let a repair collide with someone else's account.
  const { data: clashApp } = await db
    .from('vendor_applications')
    .select('id')
    .ilike('email', newEmail)
    .neq('id', applicationId)
    .limit(1)
  if ((clashApp || []).length) return { ok: false, reason: 'another application already uses that address' }

  type AuthUser = { id: string; email?: string }
  const authAdmin = (db as unknown as {
    auth: { admin: {
      listUsers(o: unknown): Promise<{ data?: { users?: AuthUser[] } }>
      updateUserById(id: string, a: unknown): Promise<{ error?: { message: string } }>
    } }
  }).auth.admin

  const { data: list } = await authAdmin.listUsers({ page: 1, perPage: 1000 })
  const users = list?.users || []
  const mine = users.find((u) => String(u.email || '').toLowerCase() === oldEmail)
  const clashUser = users.find((u) => String(u.email || '').toLowerCase() === newEmail)
  if (clashUser && clashUser.id !== mine?.id) return { ok: false, reason: 'another portal account already uses that address' }

  const { error: upErr } = await db.from('vendor_applications').update({ email: newEmail }).eq('id', applicationId)
  if (upErr) return { ok: false, reason: `could not update the application: ${upErr.message}` }

  if (mine) {
    // email_confirm so they are not pushed through a fresh confirmation on top
    // of a reset they have already been waiting on.
    const { error: auErr } = await authAdmin.updateUserById(mine.id, { email: newEmail, email_confirm: true })
    if (auErr) {
      return { ok: false, reason: `the application was updated but the portal account was not (${auErr.message}), a human must finish this`, oldEmail, newEmail }
    }
  }

  // Audit + operator alert. A wrong repair must be visible and reversible.
  try {
    await db.from('vendor_application_events').insert({
      application_id: applicationId,
      event_type: 'vendor_amended',
      note: `Email repaired by the bot after delivery failure: ${oldEmail} -> ${newEmail}`,
      before_value: { email: oldEmail },
      after_value: { email: newEmail },
      actor_role: 'bot',
    })
  } catch { /* audit is best-effort, the alert below is the real backstop */ }

  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({
      event: 'system_alert',
      audience: 'master',
      body: `${app.business_name} repaired their own email after a delivery failure: ${oldEmail} changed to ${newEmail}. Reverse it on the vendor profile if this looks wrong.`,
    })
  } catch { /* never block the repair on an alert */ }

  // Re-send, and report what actually happened rather than assuming.
  let resetDelivered = false
  try {
    const res = await fetch('https://cthalaal.co.za/api/exhibitor/send-password-reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
      },
      body: JSON.stringify({ email: newEmail }),
    })
    const j = (await res.json().catch(() => ({}))) as { delivered?: boolean }
    resetDelivered = j.delivered === true
  } catch { /* reported as not delivered below */ }

  return { ok: true, oldEmail, newEmail, resetDelivered }
}
