import { redirect } from 'next/navigation'
import { getExhibitorContext } from '@/lib/exhibitor'
import { getRole } from '@/lib/admin-rbac'
import PortalNav from '@/components/exhibitor/PortalNav'
import { parsePortalState } from '@/lib/portal-state'
import { WaOptInBanner } from '@/components/exhibitor/WaOptInBanner'
import { LogoReminderBanner } from '@/components/exhibitor/LogoReminderBanner'
import { hasUnreadAdminReply } from '@/components/exhibitor/InboxCard'

export const dynamic = 'force-dynamic'

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getExhibitorContext()
  if (!ctx) redirect('/exhibitor/login')
  if (ctx.mustChangePassword) redirect('/exhibitor/set-password')
  // Fail-closed when the auth user has no linked vendor application (Law 2).
  // Admin accounts get routed back to the admin portal; everyone else lands
  // on the vendor login. Without this, half-rendered pages call /api/exhibitor/*
  // and surface raw "Unauthorized" strings in the UI.
  if (!ctx.application) {
    const role = await getRole(ctx.userId).catch(() => null)
    redirect(role ? '/admin' : '/exhibitor/login')
  }

  // NOTE: contract-sign gate moved out of the layout into individual pages
  // (Overview + paygate). Path-detection in Next 16 layouts is unreliable, so a
  // layout-level redirect either silently fails or infinite-loops on /contract
  // itself. See KT #248.

  const businessName = (ctx.application?.business_name as string) || ctx.email
  const state = parsePortalState((ctx.application?.admin_notes as string) || null)
  const showWaBanner = !state.wa?.opted_in_at
  // Persistent logo nudge: paid but no logo uploaded. Stays on every page until
  // the vendor uploads one (then state.profile.logo_path flips this false).
  const needsLogo = state.payment?.status === 'paid' && !state.profile?.logo_path
  const contactName = (ctx.application?.contact_name as string) || ctx.email
  const firstName = (contactName || '').trim().split(/\s+/)[0] || ''
  const prefillPhone = (ctx.application?.phone as string) || ''
  const inboxUnread = await hasUnreadAdminReply({ vendorPhone: prefillPhone })

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-[#F6F2E8] text-[#1B1A17]">
      {/* Override PageShell min-h-screen inside the vendor portal so short
          pages don't force the main area to scroll. The layout constrains
          height; PageShell's 100vh minimum would exceed available space. */}
      <style>{'main > div:first-child { min-height: fit-content !important; }'}</style>
      <div className="flex-shrink-0">
        <PortalNav businessName={businessName} inboxUnread={inboxUnread} />
        {showWaBanner && <WaOptInBanner prefillPhone={prefillPhone} firstName={firstName} />}
        {needsLogo && <LogoReminderBanner firstName={firstName} />}
      </div>
      <main className="flex-1 overflow-y-auto min-h-0 pb-8">{children}</main>
    </div>
  )
}
