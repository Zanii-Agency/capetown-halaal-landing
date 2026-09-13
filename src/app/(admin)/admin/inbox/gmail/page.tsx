import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isEftAdmin } from '@/lib/eft'
import { MailWorkspace } from '../MailWorkspace'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Gmail' }
export default async function Page() {
  // Gmail (capetownhalaal@ personal mailbox) is master/dev only. The festival
  // owner works WhatsApp + Support Email; she never sees the Gmail lane, even by
  // typing the URL. Mirrors the sidebar gate (eftAdmin) and the To Do routing.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')
  if (!isEftAdmin(user.email)) redirect('/admin')
  return (
    <MailWorkspace
      mailbox="gmail"
      title="Gmail"
      subtitle="Nobody is waiting on a reply."
      sendingAs="capetownhalaal@gmail.com"
    />
  )
}
