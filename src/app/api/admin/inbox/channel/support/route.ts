// Support email (support@youngatheart, GoDaddy) channel list. Reads ONLY its own tables (see lib/inbox/channel-threads.ts):
// no shared contact map, no cross-channel filter, so a change here cannot break
// the other two. The EFT lane seal lives INSIDE the loader, not in this handler,
// so this route has no way to return a row the viewer must not see.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadMailThreads } from '@/lib/inbox/channel-threads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const { data: adminUser } = await db.from('admin_users').select('id').eq('id', user.id).maybeSingle()
  if (!adminUser) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const threads = await loadMailThreads(user.email, 'support')
  return NextResponse.json({
    channel: 'support',
    threads,
    counts: { all: threads.length, needs_response: threads.filter((t) => t.needs_response).length },
  })
}
