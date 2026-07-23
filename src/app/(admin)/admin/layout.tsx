import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getRole } from '@/lib/admin-rbac'
import type { AdminRole } from '@/lib/admin-rbac'
import { isEftAdmin } from '@/lib/eft'
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

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (user) {
      role = await getRole(user.id)
      email = user.email ?? null
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
