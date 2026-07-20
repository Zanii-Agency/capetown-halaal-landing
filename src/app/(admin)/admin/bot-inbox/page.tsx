import { redirect } from 'next/navigation'

// Retired: the Bot Inbox is now merged into the single master Inbox at
// /admin/customer-inbox (bot conversations live in wa_messages, which the
// unified inbox aggregates). Kept as a redirect so old links/bookmarks land
// in the right place. The old BotInboxClient + APIs remain in the repo.
export default function BotInboxRedirect() {
  redirect('/admin/customer-inbox')
}
