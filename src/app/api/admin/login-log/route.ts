import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { announceLogin } from '@/lib/login-announce'

// Records and announces a sign-in. Called by BOTH admin and vendor login forms
// after the session cookie is set, so it must not assume the caller is an admin:
// announceLogin resolves the role itself.
//
// The client sends NOTHING. Identity comes from the session cookie just set and
// the IP from the edge headers, because a body-supplied email or IP would be
// attacker-controlled and would make this a place to write fiction.
export async function POST() {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  await announceLogin(createAdminClient(), await headers(), user, 'admin form')
  return NextResponse.json({ ok: true })
}
