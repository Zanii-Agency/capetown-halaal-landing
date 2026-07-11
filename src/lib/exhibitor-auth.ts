import { createAdminClient } from '@/lib/supabase/admin'
import { randomBytes } from 'crypto'

// Readable-but-random temp password, e.g. "Khcd4821!"
// Audit L1: CSPRNG via crypto.randomBytes instead of Math.random so the
// temporary creds can't be guessed by an attacker who knows the time of
// account provisioning.
function genPassword(): string {
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ'
  const buf = randomBytes(9)
  let s = upper[buf[0] % upper.length]
  for (let i = 1; i <= 4; i++) s += lower[buf[i] % lower.length]
  const digits = (buf.readUInt16BE(5) % 9000) + 1000
  s += String(digits)
  return s + '!'
}

type Admin = ReturnType<typeof createAdminClient>

async function findUserByEmail(admin: Admin, email: string) {
  const target = email.toLowerCase()
  for (let page = 1; page <= 6; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error || !data?.users?.length) break
    const u = data.users.find((u) => (u.email || '').toLowerCase() === target)
    if (u) return u
    if (data.users.length < 200) break
  }
  return null
}

/**
 * Create (or reset) the vendor's portal account on approval.
 * Links the auth user to its application via user_metadata.application_id, so the
 * portal resolves the right vendor without any schema change. Returns the temp
 * password to put in the approval email. Idempotent: re-approving resets it.
 */
export async function provisionExhibitorAccount(opts: {
  email: string
  applicationId: string
  businessName: string
}): Promise<{ tempPassword: string; userId: string | null }> {
  const admin = createAdminClient()
  const tempPassword = genPassword()
  const user_metadata = {
    application_id: opts.applicationId,
    role: 'owner',
    must_change_password: true,
    business_name: opts.businessName,
  }

  const { data, error } = await admin.auth.admin.createUser({
    email: opts.email,
    password: tempPassword,
    email_confirm: true,
    user_metadata,
  })

  let userId = data?.user?.id ?? null
  if (error) {
    // Email already has an account -> reset password + relink metadata.
    const existing = await findUserByEmail(admin, opts.email)
    if (!existing) throw error
    userId = existing.id
    await admin.auth.admin.updateUserById(existing.id, { password: tempPassword, user_metadata })
  }

  return { tempPassword, userId }
}

/**
 * Keep the Supabase Auth login identity in sync when an admin (Samreen) amends a
 * vendor's application. The login is Supabase Auth keyed on auth.users.email, a
 * SEPARATE store from vendor_applications.email — editing the application row
 * alone silently desyncs the two, leaving the vendor locked out (they log in with
 * the corrected email but no account answers to it). This propagates the edit.
 *
 * Looks the auth user up by the OLD email (what the row held before the edit,
 * which is what the auth account still answers to when the two were in sync).
 * If the vendor has no auth account yet (still pending, never approved) it's a
 * no-op. Non-fatal by contract: returns a flag, never throws, so an amend never
 * fails because of an auth hiccup.
 */
export async function syncExhibitorAuth(opts: {
  oldEmail: string
  newEmail?: string
  businessName?: string
}): Promise<{ updated: boolean; userId?: string; error?: string }> {
  try {
    const admin = createAdminClient()
    const user = await findUserByEmail(admin, opts.oldEmail)
    if (!user) return { updated: false } // unapproved / no login to sync
    const patch: { email?: string; email_confirm?: boolean; user_metadata?: Record<string, unknown> } = {}
    if (opts.newEmail && opts.newEmail.toLowerCase() !== opts.oldEmail.toLowerCase()) {
      patch.email = opts.newEmail
      patch.email_confirm = true // admin-verified change; no confirmation round-trip
    }
    if (opts.businessName) {
      patch.user_metadata = { ...(user.user_metadata || {}), business_name: opts.businessName }
    }
    if (!patch.email && !patch.user_metadata) return { updated: false, userId: user.id }
    const { error } = await admin.auth.admin.updateUserById(user.id, patch)
    if (error) return { updated: false, userId: user.id, error: error.message }
    return { updated: true, userId: user.id }
  } catch (e) {
    return { updated: false, error: (e as Error).message }
  }
}
