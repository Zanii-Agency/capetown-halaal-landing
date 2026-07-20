import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export interface ExhibitorContext {
  userId: string
  email: string
  mustChangePassword: boolean
  role: 'owner' | 'staff'
  application: Record<string, unknown> | null
}

/**
 * Server-side: resolve the signed-in exhibitor + their live application row.
 * The auth user is linked to a vendor_application via user_metadata.application_id
 * (set when admin approves), so this works without any schema change.
 * Returns null when nobody is signed in.
 */
export async function getExhibitorContext(): Promise<ExhibitorContext | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const meta = user.user_metadata || {}
  const applicationId = meta.application_id as string | undefined

  let application: Record<string, unknown> | null = null
  const admin = createAdminClient()
  if (applicationId) {
    const { data } = await admin
      .from('vendor_applications')
      .select('*')
      .eq('id', applicationId)
      .maybeSingle()
    application = data ?? null
  }

  // ATO GUARD (CRITICAL — account-takeover root). `user_metadata.application_id`
  // is CLIENT-WRITABLE (the portal itself calls supabase.auth.updateUser({data}))
  // so an authenticated vendor could repoint it at ANY other application UUID and
  // read/act on the victim's data. The metadata claim must therefore be BACKED by
  // a server-set, non-client-writable link before we trust it:
  //   1. auth_user_id (migration v7) — the immutable auth user id, set with the
  //      admin client at approval. The user cannot change their own user.id, nor
  //      this column. This is the spoof-proof binding.
  //   2. email fallback — for rows provisioned before v7 (auth_user_id null), the
  //      auth user was created with the application's own email, and the session
  //      email is Supabase-verified (changing it requires confirming the new
  //      address), so it cannot be set to a victim's value.
  // Fail CLOSED: if neither matches, the metadata is forged — drop the binding.
  if (application) {
    const linkedUserId = (application.auth_user_id as string | null) || null
    const appEmail = (application.email as string | null)?.toLowerCase() || null
    const sessionEmail = user.email?.toLowerCase() || null
    const ownsByUserId = !!linkedUserId && linkedUserId === user.id
    const ownsByEmail = !linkedUserId && !!appEmail && !!sessionEmail && appEmail === sessionEmail
    if (!ownsByUserId && !ownsByEmail) {
      console.error(
        '[exhibitor] ATO guard: application_id metadata not backed by auth_user_id or email for user',
        user.id, '— refusing binding (Law 2).',
      )
      application = null
    }
  }
  // CTH-DOCTRINE Law 2 (vendor-data-privacy). The binding above is the only path
  // to an application: a metadata application_id claim that is BACKED by the
  // immutable server-set auth_user_id (post-v7), or — for legacy pre-v7 rows —
  // a match between the application's own email and the Supabase-verified session
  // email (email change requires confirming the new address, so it can't be set
  // to a victim's value). Anything else fails closed (application stays null).
  if (!application) {
    console.warn('[exhibitor] no application bound for user', user.id, '(missing/forged metadata link, or unmatched). Re-link via admin if this is a legit vendor.')
  }

  return {
    userId: user.id,
    email: user.email || '',
    mustChangePassword: !!meta.must_change_password,
    role: (meta.role as 'owner' | 'staff') || 'owner',
    application,
  }
}
