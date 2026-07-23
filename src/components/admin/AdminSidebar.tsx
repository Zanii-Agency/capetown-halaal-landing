'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { LayoutDashboard, FileText, Files, Ticket, LogOut, ExternalLink, Globe, BarChart3, ShieldCheck, Shield, Eye, Menu, X, Megaphone, Users, Map, Search, Settings as SettingsIcon, IdCard, ChevronLeft, ChevronRight, Activity, PanelLeftClose, LifeBuoy, BookOpen, Wallet, MessageCircle, Tent, ArrowLeftRight, Bell } from 'lucide-react'
import { Z_CLASS } from '@/lib/z'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { AdminRole } from '@/lib/admin-rbac'

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard }
type NavGroup = { label: string | null; items: NavItem[] }

// Sidebar is now grouped into labelled sections. The DASHBOARD group has a
// null label (no header rendered) so the top item still feels primary. Every
// other group renders a small uppercase header above its items.
const navGroups: NavGroup[] = [
  {
    label: null,
    items: [
      { name: 'Dashboard', href: '/admin', icon: LayoutDashboard },
    ],
  },
  {
    label: 'OPERATIONS',
    items: [
      { name: 'Applications', href: '/admin/applications', icon: FileText },
      { name: 'Allocation', href: '/admin/allocation', icon: Map },
      { name: 'Outside Vendors', href: '/admin/outside', icon: Tent },
      { name: 'Stall Changes', href: '/admin/stall-changes', icon: ArrowLeftRight },
      { name: 'Vendors', href: '/admin/vendors', icon: Users },
      { name: 'People', href: '/admin/people', icon: IdCard },
      { name: 'Documents', href: '/admin/documents', icon: Files },
      { name: 'Verifier', href: '/admin/verifier', icon: ShieldCheck },
    ],
  },
  {
    label: 'COMMUNICATIONS',
    items: [
      { name: 'Inbox', href: '/admin/customer-inbox', icon: MessageCircle },
      { name: 'Needs You', href: '/admin/customer-inbox?view=needs', icon: Bell },
      { name: 'Broadcast', href: '/admin/broadcast', icon: Megaphone },
      { name: 'Contacts', href: '/admin/contacts', icon: BookOpen },
    ],
  },
  {
    label: 'MONEY',
    items: [
      { name: 'Finance', href: '/admin/finance', icon: Wallet },
      { name: 'Tickets', href: '/admin/tickets', icon: Ticket },
    ],
  },
  {
    label: 'SYSTEM',
    items: [
      { name: 'Analytics', href: '/admin/analytics', icon: BarChart3 },
      { name: 'Activity Feed', href: '/admin/settings/activity', icon: Activity },
      { name: 'Operators', href: '/admin/settings/operators', icon: Shield },
      { name: 'Audit Log', href: '/admin/settings/audit', icon: FileText },
      { name: 'Comms Health', href: '/admin/settings/comms-health', icon: Activity },
    ],
  },
]

interface AdminSidebarProps {
  role: AdminRole
  email: string | null
  // TEMPORARY EFT lane: show the dev-only /admin/eft nav item. Computed in the
  // server layout (isEftAdmin) so this client component never imports @/lib/eft.
  eftAdmin?: boolean
}

const ROLE_BADGE_STYLE: Record<AdminRole, { label: string; cls: string; Icon: typeof Shield }> = {
  owner:    { label: 'Owner',    cls: 'bg-[#cd2653]/10 text-[#cd2653] border-[#cd2653]/30', Icon: ShieldCheck },
  operator: { label: 'Operator', cls: 'bg-blue-50 text-blue-700 border-blue-200',          Icon: Shield },
  viewer:   { label: 'Viewer',   cls: 'bg-neutral-100 text-neutral-600 border-neutral-200', Icon: Eye },
}

export function AdminSidebar({ role, email, eftAdmin }: AdminSidebarProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()
  const badge = ROLE_BADGE_STYLE[role]
  // TEMPORARY EFT lane: inject the dev-only EFT item into the MONEY group.
  const groups: NavGroup[] = eftAdmin
    ? navGroups.map((g) =>
        g.label === 'MONEY'
          ? { ...g, items: [...g.items, { name: 'EFT (Yoco down)', href: '/admin/eft', icon: LifeBuoy }] }
          : g,
      )
    : navGroups
  const BadgeIcon = badge.Icon
  const [mobileOpen, setMobileOpen] = useState(false)
  const [supportUnread, setSupportUnread] = useState(0)
  const [needsResponse, setNeedsResponse] = useState(0)
  const [pendingApps, setPendingApps] = useState<number | null>(null)
  // Collapsed state for desktop (lg+) sidebar. Persisted to localStorage so the
  // operator's preference survives reloads. Mobile drawer is unaffected.
  const [collapsed, setCollapsed] = useState(false)

  // Hydrate collapsed state from localStorage on mount. Guarded for SSR.
  useEffect(() => {
    try {
      const v = localStorage.getItem('admin.sidebarCollapsed')
      if (v === '1') setCollapsed(true)
    } catch { /* private mode / SSR */ }
  }, [])

  // Persist collapsed changes.
  useEffect(() => {
    try {
      localStorage.setItem('admin.sidebarCollapsed', collapsed ? '1' : '0')
    } catch { /* private mode / SSR */ }
  }, [collapsed])

  // Close drawer on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  // Poll the unified inbox unread count for the sidebar badge. Fires every 60s
  // when the tab is visible. Best-effort, sidebar still works if it fails.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const res = await fetch('/api/admin/inbox/unified?channel=all')
        if (!res.ok) return
        const j = await res.json()
        if (cancelled) return
        setSupportUnread(j.counts?.unread || 0)
        setNeedsResponse(j.counts?.needs_response || 0)
      } catch { /* swallow */ }
    }
    tick()
    // 30s (was 60s) so the Needs You / unread badges track the inbox page more
    // closely — a 60s badge visibly lagged the live queue count.
    const id = setInterval(tick, 30000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Poll pending application count for the Applications badge. Reads from the
  // shared /api/admin/stats endpoint. Falls back to no badge if the shape
  // differs (e.g. endpoint not yet updated by sibling work). Polls every 60s.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const res = await fetch('/api/admin/stats')
        if (!res.ok) return
        const j = await res.json()
        if (cancelled) return
        // Endpoint nests stats under `stats.pending` per current route.ts.
        // Accept either top-level `pending` or `stats.pending` to be resilient.
        const pending =
          typeof j?.pending === 'number' ? j.pending :
          typeof j?.stats?.pending === 'number' ? j.stats.pending :
          null
        setPendingApps(pending)
      } catch { /* swallow */ }
    }
    tick()
    const id = setInterval(tick, 60000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const handleLogout = async () => {
    const supabase = createClient()
    // B8: { scope: 'global' } revokes ALL refresh tokens for this user
    // server-side, not just the local cookie. Without this, a stolen
    // refresh token survives "sign out" and continues to mint new
    // access tokens. signOut still clears local cookies even when the
    // network call fails, so we don't await result.error specifically.
    await supabase.auth.signOut({ scope: 'global' })
    // B9: clear CommandK recent-search localStorage so the next person
    // on a shared device cannot read what the previous admin searched
    // for (phone numbers, vendor names, etc.).
    try {
      localStorage.removeItem('admin.commandk.recent')
    } catch {
      // private mode / SSR safety
    }
    router.push('/admin/login')
  }

  const isItemActive = (href: string) =>
    pathname === href || (href !== '/admin' && pathname.startsWith(href))

  const sidebarBody = (
    <>
      {/* Logo block: horizontal, tight against text (matches main site treatment).
          Drops the h-32 stacked layout for h-12 inline. Collapse toggle lives
          here so it is always visible, not buried at the bottom. */}
      <div className={cn('border-b border-neutral-200 relative', collapsed ? 'px-2 py-3' : 'px-4 py-4')}>
        {collapsed ? (
          <div className="flex justify-center">
            <Image
              src="/logo.png"
              alt="Young at Heart"
              width={48}
              height={48}
              priority
              className="h-12 w-12 object-contain"
            />
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <Image
              src="/logo.png"
              alt="Young at Heart"
              width={48}
              height={48}
              priority
              className="h-10 w-10 object-contain flex-shrink-0"
            />
            <div className="leading-tight min-w-0">
              <p className="font-bold text-sm text-neutral-900 truncate">Young at Heart</p>
              <p className="text-[10px] text-neutral-500">Admin Portal</p>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="md:hidden absolute top-3 right-3 -m-2 p-2 text-neutral-500 hover:text-neutral-900 min-h-[44px] min-w-[44px]"
          aria-label="Close menu"
        >
          <X className="w-5 h-5" />
        </button>
        {/* Sidebar collapse toggle — top-right when expanded. */}
        {!collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="hidden lg:flex absolute top-3 right-3 p-1.5 rounded-lg text-neutral-400 hover:text-[#cd2653] hover:bg-neutral-100 transition-colors"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 overflow-y-auto">
        {groups.map((group, gi) => (
          <div key={group.label ?? `group-${gi}`} className="space-y-1">
            {group.label && !collapsed && (
              <p className="px-4 mt-6 mb-1 text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                {group.label}
              </p>
            )}
            {group.items.map((item) => {
              // Inbox and Needs You share the /admin/customer-inbox path and are
              // told apart by the ?view=needs query (usePathname drops the query,
              // so disambiguate with searchParams).
              const onInbox = pathname.startsWith('/admin/customer-inbox')
              const isNeedsView = searchParams.get('view') === 'needs'
              const isActive = item.href.includes('view=needs')
                ? (onInbox && isNeedsView)
                : item.href === '/admin/customer-inbox'
                  ? (onInbox && !isNeedsView)
                  : isItemActive(item.href)
              const badgeNum = item.href.includes('view=needs') ? needsResponse
                : item.href === '/admin/customer-inbox' ? supportUnread
                : item.href === '/admin/applications' ? pendingApps
                : null
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  title={collapsed ? item.name : undefined}
                  className={cn(
                    'relative flex items-center rounded-md text-sm font-medium transition-colors',
                    collapsed ? 'justify-center px-2 py-3' : 'gap-3 px-3 py-2',
                    isActive ? 'bg-[#cd2653] text-white' : 'text-neutral-600 hover:bg-neutral-100'
                  )}
                >
                  <item.icon className="w-4.5 h-4.5 flex-shrink-0" />
                  {!collapsed && <span className="flex-1">{item.name}</span>}
                  {!collapsed && badgeNum !== null && badgeNum > 0 && (
                    <span className={cn(
                      'text-[10px] font-bold rounded-full px-1.5 py-0.5',
                      isActive ? 'bg-white text-[#cd2653]' : 'bg-[#cd2653] text-white'
                    )}>{badgeNum}</span>
                  )}
                  {collapsed && badgeNum !== null && badgeNum > 0 && (
                    <span className={cn(
                      'absolute top-1 right-1 w-2 h-2 rounded-full ring-2 ring-white',
                      isActive ? 'bg-white' : 'bg-[#cd2653]'
                    )} />
                  )}
                </Link>
              )
            })}
          </div>
        ))}

        {/* External group lives at the bottom, separated by a thin divider. */}
        {!collapsed && <div className="pt-3 mt-4 border-t border-neutral-200/30">
          <p className="px-4 text-[10px] font-medium text-neutral-400 uppercase tracking-wider mb-1.5">External</p>
          <a
            href="https://tickets.youngatheart.co.za"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 px-4 py-2 min-h-[36px] rounded-lg text-xs font-medium text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Ticket Store
          </a>
          <a
            href="https://cthalaal.co.za"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 px-4 py-2 min-h-[36px] rounded-lg text-xs font-medium text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Main Website
          </a>
        </div>}
      </nav>

      {/* Sidebar collapse toggle — dedicated row between nav and account
          section. Always in the same position regardless of state. Desktop
          only: on mobile the sidebar is a full-width drawer, so collapsing
          (which just narrows the md+ rail) is meaningless clutter. */}
      <div className={cn('hidden md:block border-t border-neutral-200', collapsed ? 'px-2 py-2' : 'px-3 py-2')}>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'flex items-center rounded-lg text-sm font-medium text-neutral-500 hover:text-[#cd2653] hover:bg-neutral-100 w-full transition-colors min-h-[36px]',
            collapsed ? 'justify-center px-2' : 'gap-2 px-3'
          )}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          {!collapsed && <span className="text-xs">Collapse sidebar</span>}
        </button>
      </div>

      {/* Back to Site */}
      {!collapsed && <div className="px-3 pb-2">
        <a
          href="https://cthalaal.co.za"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-4 py-3 min-h-[44px] rounded-lg text-sm font-medium text-white bg-[#cd2653] hover:bg-[#b01f45] w-full transition-colors"
        >
          <Globe className="w-4.5 h-4.5" />
          View Live Site
        </a>
      </div>}

      {/* Role chip + Logout */}
      <div className="p-3 border-t border-neutral-200 space-y-2">
        {!collapsed && (
          <button
            onClick={() => {
              try {
                window.localStorage.setItem('admin.tour_state', JSON.stringify({ step: 0, active: true }))
                window.location.reload()
              } catch { /* ignore */ }
            }}
            className="flex items-center gap-3 px-3 py-2 w-full rounded-lg text-xs font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 transition-colors min-h-[36px]"
          >
            <BookOpen className="w-4 h-4" />
            Guide
          </button>
        )}
        {!collapsed && <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-neutral-400 uppercase tracking-wider">Signed in</p>
            <p className="text-xs text-neutral-700 truncate" title={email ?? ''}>
              {email ?? 'admin'}
            </p>
          </div>
          <span
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border',
              badge.cls
            )}
            title={`Role: ${badge.label}`}
          >
            <BadgeIcon className="w-3 h-3" />
            {badge.label}
          </span>
        </div>}
        <button
          onClick={handleLogout}
          title={collapsed ? 'Sign Out' : undefined}
          className={cn(
            'flex items-center rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-100 w-full transition-colors min-h-[44px]',
            collapsed ? 'justify-center px-2 py-3' : 'gap-3 px-4 py-3'
          )}
        >
          <LogOut className="w-4.5 h-4.5 flex-shrink-0" />
          {!collapsed && <>Sign Out</>}
        </button>
      </div>
    </>
  )

  return (
    <>
      {/* Mobile top bar */}
      <div className={cn('md:hidden sticky top-0 flex items-center justify-between bg-white border-b border-neutral-200 px-3 py-2', Z_CLASS.drawer)}>
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center text-neutral-700 hover:text-neutral-900"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="text-sm font-semibold text-neutral-900">Young at Heart Admin</div>
        <div className="flex items-center gap-1">
          {/* Mobile search trigger: dispatches a synthetic Cmd+K so CommandK
              (which already owns the keydown listener) opens. Avoids the
              cross-component coupling problem of wiring a setOpen ref into a
              component owned by a sibling agent. */}
          <button
            type="button"
            data-cmdk-trigger="true"
            onClick={() => {
              const ev = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
              document.dispatchEvent(ev)
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-neutral-700 hover:text-neutral-900"
            aria-label="Open command palette"
          >
            <Search className="w-5 h-5" />
          </button>
          <span
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border',
              badge.cls
            )}
            title={`Role: ${badge.label}`}
          >
            <BadgeIcon className="w-3 h-3" />
            {badge.label}
          </span>
        </div>
      </div>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div
          className={cn('md:hidden fixed inset-0 bg-black/40', Z_CLASS.drawer)}
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'bg-white border-r border-neutral-200 flex flex-col transition-[width] duration-200 ease-out',
          // mobile: drawer (sits above the overlay backdrop on the modal layer)
          'fixed inset-y-0 left-0 w-72 transform transition-transform md:relative md:translate-x-0 md:h-screen md:overflow-hidden',
          collapsed ? 'md:w-16' : 'md:w-64',
          Z_CLASS.modal,
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        )}
      >
        {sidebarBody}
      </aside>
    </>
  )
}
