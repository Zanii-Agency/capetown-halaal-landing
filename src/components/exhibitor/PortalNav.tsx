'use client'

import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutGrid, MapPin, FileCheck, Users, Megaphone,
  CreditCard, Store, BookOpen, LogOut, Sparkles,
  MessageCircle, Settings,
} from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

interface NavItem {
  href: string
  label: string
  icon: typeof LayoutGrid
}

const NAV_GROUPS: NavItem[] = [
  { href: '/exhibitor/portal', label: 'Overview', icon: LayoutGrid },
  { href: '/exhibitor/portal/stand', label: 'My Stand', icon: MapPin },
  { href: '/exhibitor/portal/documents', label: 'Documents', icon: FileCheck },
  { href: '/exhibitor/portal/marketing', label: 'Marketing', icon: Sparkles },
  { href: '/exhibitor/portal/announcements', label: 'Announcements', icon: Megaphone },
  { href: '/exhibitor/portal/support', label: 'Support', icon: MessageCircle },
]

const ACCOUNT: NavItem[] = [
  { href: '/exhibitor/portal/payments', label: 'Payments', icon: CreditCard },
  { href: '/exhibitor/portal/profile', label: 'Profile', icon: Store },
  { href: '/exhibitor/portal/resources', label: 'Resources', icon: BookOpen },
  { href: '/exhibitor/portal/staff', label: 'Staff & Badges', icon: Users },
  { href: '/exhibitor/portal/settings', label: 'Account Settings', icon: Settings },
]

function initials(name: string) {
  const clean = name.replace(/^DEMO\s*·?\s*/i, '').trim()
  return (clean[0] || 'Y').toUpperCase()
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, cb: () => void) {
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) cb()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [ref, cb])
}

export default function PortalNav({ businessName, inboxUnread = false }: { businessName: string; inboxUnread?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const cleanName = businessName.replace(/^DEMO\s*·?\s*/i, '')

  useClickOutside(menuRef, () => setMenuOpen(false))

  async function signOut() {
    setSigningOut(true)
    await createClient().auth.signOut()
    router.push('/exhibitor/login'); router.refresh()
  }

  function isActive(href: string) {
    if (href === '/exhibitor/portal') return pathname === href
    return pathname === href || pathname.startsWith(href + '/')
  }

  return (
    <div className="sticky top-0 z-50 bg-[#fbfafa]/85 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3">
        <div className="flex items-center gap-4 lg:gap-6 bg-white border border-neutral-200/80 rounded-2xl shadow-[0_6px_24px_rgba(20,15,17,0.06)] px-4 min-h-[72px] py-2.5">
          <a href="/exhibitor/portal" className="flex items-center gap-3 min-h-[3.5rem] shrink-0 pr-3 lg:pr-5 border-r border-neutral-100">
            <img
              src="/logo.png"
              alt="Young at Heart"
              className="h-10 w-auto object-contain flex-shrink-0"
            />
            <span className="hidden lg:flex flex-col justify-center leading-tight">
              <span className="block font-bold text-neutral-900 text-sm">Young at Heart</span>
              <span className="block text-[10px] text-neutral-400">Exhibitor portal</span>
            </span>
          </a>

          {/* Nav buttons with horizontal scroll */}
          <div className="flex items-center gap-2 lg:gap-3 flex-1 justify-center min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {NAV_GROUPS.map((g) => {
              const active = isActive(g.href)
              const Icon = g.icon
              const showDot = inboxUnread && (g.href === '/exhibitor/portal/support' || g.href === '/exhibitor/portal')

              return (
                <a key={g.href} href={g.href}
                  className={`relative flex items-center gap-2 rounded-full px-4 lg:px-5 py-2 text-sm font-medium whitespace-nowrap transition-colors ${active ? 'bg-[#cd2653] text-white shadow-sm ring-1 ring-[#cd2653]/40' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}>
                  <Icon className="w-4 h-4" />{g.label}
                  {showDot && (
                    <span aria-label="unread" className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white ${active ? 'bg-white' : 'bg-[#cd2653]'}`} />
                  )}
                </a>
              )
            })}
          </div>

          {/* Avatar menu */}
          <div className="relative shrink-0" ref={menuRef}>
            <button onClick={() => setMenuOpen((o) => !o)}
              aria-label="Account menu"
              aria-expanded={menuOpen}
              className="w-9 h-9 rounded-full bg-[#cd2653] text-white text-sm font-bold flex items-center justify-center hover:opacity-90 ring-1 ring-transparent hover:ring-[#cd2653]/30 transition-all">
              {initials(businessName)}
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-2 w-56 bg-white border border-neutral-200 rounded-2xl shadow-xl p-1.5 z-50">
                <div className="px-3 py-2 border-b border-neutral-100 mb-1">
                  <p className="text-sm font-semibold text-neutral-900 truncate">{cleanName}</p>
                  <p className="text-xs text-neutral-400">Exhibitor account</p>
                </div>
                {ACCOUNT.map((i) => {
                  const active = pathname === i.href
                  const AIcon = i.icon
                  return (
                    <a key={i.href} href={i.href} onClick={() => setMenuOpen(false)}
                      className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm ${active ? 'text-[#cd2653] bg-[#cd2653]/5 font-medium' : 'text-neutral-700 hover:bg-neutral-50'}`}>
                      <AIcon className="w-4 h-4" />{i.label}
                    </a>
                  )
                })}
                <button onClick={signOut} disabled={signingOut}
                  className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 mt-1 border-t border-neutral-100 pt-2.5">
                  <LogOut className="w-4 h-4" /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
