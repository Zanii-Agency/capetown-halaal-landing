import { redirect } from 'next/navigation'

// Retired: the Support Inbox is now merged into the single master Inbox at
// /admin/customer-inbox (email/support threads are aggregated there). Kept as a
// redirect so old links/bookmarks land in the right place. The old
// SupportInboxClient + APIs remain in the repo.
export default function SupportInboxRedirect() {
  redirect('/admin/customer-inbox')
}
