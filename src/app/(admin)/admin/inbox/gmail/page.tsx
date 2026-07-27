import { MailWorkspace } from '../MailWorkspace'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Gmail' }

export default function Page() {
  return (
    <MailWorkspace
      mailbox="gmail"
      title="Gmail"
      subtitle="Nobody is waiting on a reply."
      sendingAs="capetownhalaal@gmail.com"
    />
  )
}
