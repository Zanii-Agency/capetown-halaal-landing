import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getRole } from '@/lib/admin-rbac'
import type { AdminRole } from '@/lib/admin-rbac'
import { isEftAdmin } from '@/lib/eft'
import { pingAdminActivity } from '@/lib/admin-activity-ping'
import { AdminSidebar } from '@/components/admin/AdminSidebar'
import { CommandK } from '@/components/admin/CommandK'

export const dynamic = 'force-dynamic'

const PUBLIC_ADMIN_PATHS = new Set<string>([
  '/admin/login',
])

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let role: AdminRole | null = null
  let email: string | null = null
  let userId: string | null = null

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (user) {
      role = await getRole(user.id)
      email = user.email ?? null
      userId = user.id
    }
  } catch (e) {
    console.error('Admin layout auth error:', e)
  }

  if (!role) {
    const h = await headers()
    const pathname = h.get('x-pathname') || ''
    if (PUBLIC_ADMIN_PATHS.has(pathname)) {
      return <>{children}</>
    }
    redirect('/admin/login')
  }

  // "She is on the panel RIGHT NOW and I got no alert" (2026-08-01): a still
  // alive session never re-announces, so record + alert on the first panel
  // load in a 12h window. Runs after the response, never blocks the page.
  if (email && userId) {
    const h = await headers()
    const snapshot = new Map<string, string>()
    for (const k of ['x-forwarded-for', 'x-real-ip', 'x-vercel-ip-city', 'x-vercel-ip-country-region', 'x-vercel-ip-country', 'cf-ipcountry']) {
      const v = h.get(k)
      if (v) snapshot.set(k, v)
    }
    const shim = { get: (k: string) => snapshot.get(k) ?? null }
    const uid = userId
    const em = email
    const r = role
    after(() => pingAdminActivity(createAdminClient(), shim, { id: uid, email: em }, r))
  }

  return (
    <div className="md:h-screen md:overflow-hidden bg-[#f8f8f8] md:flex" style={{
        '--admin-bg': '#f8f8f8',
        '--admin-card-bg': '#ffffff',
        '--admin-text-primary': '#171717',
        '--admin-text-secondary': '#737373',
        '--admin-text-muted': '#a3a3a3',
        '--admin-border': '#e5e5e5',
        '--admin-accent': '#cd2653',
      } as React.CSSProperties}>
      <AdminSidebar role={role} email={email} eftAdmin={isEftAdmin(email)} />
      <main className="flex-1 min-w-0 md:overflow-y-auto md:h-screen">
        {children}
      </main>
      <CommandK />
    </div>
  )
}
