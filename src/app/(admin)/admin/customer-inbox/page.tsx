import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { CustomerInboxClient } from './CustomerInboxClient'
import { NeedsYouClient } from './NeedsYouClient'

export const dynamic = 'force-dynamic'

export default async function CustomerInboxPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')

  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users').select('id').eq('id', user.id).single()
  if (!adminUser) redirect('/admin/login')

  // Needs You is its own dedicated triage surface, not the inbox with a filter.
  const { view } = await searchParams
  if (view === 'needs') return <NeedsYouClient />

  let operators: { id: string; email: string }[] = []
  try {
    const { data } = await admin.from('admin_users').select('id, email').limit(50)
    operators = (data || []) as { id: string; email: string }[]
  } catch { /* fallback to empty */ }

  return <CustomerInboxClient currentUserId={user.id} operators={operators || []} />
}
