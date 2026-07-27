import { MailWorkspace } from '../MailWorkspace'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Support Email' }

export default function Page() {
  return (
    <MailWorkspace
      mailbox="support"
      title="Support Email"
      subtitle="Nobody is waiting on a reply."
      sendingAs="support@youngatheart.co.za"
    />
  )
}
