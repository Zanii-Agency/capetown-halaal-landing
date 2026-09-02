import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { User } from '@supabase/supabase-js'
import { getActor } from '@/lib/admin-actor'

export async function createClient() {
  // Machine caller (the /api/mcp channel) already resolved to an admin_users
  // row: answer auth.getUser() with that person so every viewer-keyed rule
  // (RBAC, master-lane wall) sees the same identity as their browser login.
  // Only the three admin routes that query through THIS client would differ
  // (they would run as anon); none of them is exposed on the MCP channel.
  const actor = getActor()
  if (actor) {
    const client = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
      { cookies: { getAll: () => [], setAll: () => {} } },
    )
    const user = { id: actor.id, email: actor.email ?? undefined, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '' } as unknown as User
    client.auth.getUser = async () => ({ data: { user }, error: null })
    return client
  }

  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from Server Component, ignore
          }
        },
      },
    }
  )
}
