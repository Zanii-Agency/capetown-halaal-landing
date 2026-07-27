import { redirect } from 'next/navigation'

// Retired. Support email now lives in its own channel workspace at
// /admin/inbox/support, and this stays only so old links and bookmarks land
// somewhere useful. SupportInboxClient was deleted with the merged inbox.
export default function SupportInboxRedirect() {
  redirect('/admin/inbox/support')
}
