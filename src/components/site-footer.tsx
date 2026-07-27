'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Instagram, Facebook, Mail, Phone, Calendar, MapPin } from 'lucide-react'
import { Logo } from '@/components/logo'
import { ZaniiCredit } from '@/components/zanii-credit'
import { showsSiteFooter } from '@/lib/site-chrome'

/**
 * The site footer. ONE of them.
 *
 * WHAT THIS REPLACED. There were two: a full footer inlined at the bottom of
 * app/page.tsx, and a slim legal strip mounted globally from the root layout.
 * On the homepage they stacked, each with its own <footer> landmark, its own
 * `border-t`, its own `bg-neutral-50`, and DIFFERENT container widths
 * (`container mx-auto px-4` against `max-w-6xl px-6`) — which is why the legal
 * text visibly failed to line up with the columns above it. On every other page
 * the legal strip appeared alone, with no brand, no navigation and no contact
 * details. Taona, 2026-07-28: "this footer isnt right in my point of view".
 *
 * It also said everything twice. The support address, the phone number, the
 * venue and the dates each appeared in both halves, so the eye had to work out
 * whether the two copies disagreed.
 *
 * Now: one landmark, one container, three tiers that answer three different
 * questions — where do I go next, who are you legally, and who made this.
 *
 * THE LEGAL TIER IS LOAD-BEARING, NOT DECORATION. Published policies, a
 * customer-service contact, the transaction currency (ZAR) and the country of
 * domicile are what FNB checks before activating the merchant account. Keep all
 * four if you rework this.
 *
 * Anchors are written as `/#about`, not `#about`. The old footer used an onClick
 * that called document.querySelector, which silently did nothing anywhere except
 * the homepage — and this component now renders on every page. globals.css
 * already sets `scroll-behavior: smooth`, so plain hrefs still scroll smoothly
 * and the click handler is gone entirely.
 */

const EXPLORE = [
  { label: 'About', href: '/#about' },
  { label: 'Apply as Vendor', href: '/apply' },
  { label: 'Buy Tickets', href: 'https://tickets.youngatheart.co.za', external: true },
  { label: 'Gallery', href: '/#gallery' },
  { label: 'Sponsors', href: '/#sponsors' },
]

const LEGAL = [
  { label: 'Terms & Conditions', href: '/terms' },
  { label: 'Refund & Cancellation', href: '/refund-policy' },
  { label: 'Privacy Policy', href: '/privacy' },
  { label: 'Contact', href: '/contact' },
]

// YouTube was here with href="#". A social icon that goes nowhere is worse than
// one fewer icon, so it stays out until there is a channel to point at.
const SOCIALS = [
  { Icon: Instagram, href: 'https://www.instagram.com/youngatheart_capetown/', label: 'Instagram' },
  { Icon: Facebook, href: 'https://www.facebook.com/capetownhalaal/', label: 'Facebook' },
]

export function SiteFooter() {
  // Mounted in the root layout, so it would otherwise render inside the admin
  // console and the exhibitor portal, both fixed-height app shells. See
  // lib/site-chrome.ts for why the rule lives there rather than inline.
  if (!showsSiteFooter(usePathname())) return null

  return (
    <footer id="contact" className="border-t border-neutral-200 bg-neutral-50">
      <div className="mx-auto max-w-6xl px-6">
        {/* ── Tier 1: who we are, and where to go next ─────────────────── */}
        <div className="grid gap-10 py-14 md:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1.3fr]">
          <div>
            <Logo size="lg" showText className="mb-5" />
            {/* The blurb no longer repeats the dates and venue: those are one
                column to the right, and saying them twice invited them to drift. */}
            <p className="max-w-xs text-sm leading-relaxed text-neutral-600">
              Cape Town&apos;s halaal lifestyle exhibition. Food, fashion, beauty and travel,
              under one roof.
            </p>
            <div className="mt-6 flex gap-3">
              {SOCIALS.map(({ Icon, href, label }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-neutral-600 ring-1 ring-neutral-200 transition-colors hover:text-[#cd2653] hover:ring-[#cd2653]/40"
                >
                  <Icon className="h-[18px] w-[18px]" />
                </a>
              ))}
            </div>
          </div>

          <FooterCol title="Explore">
            {EXPLORE.map((l) =>
              l.external ? (
                <li key={l.label}>
                  <a href={l.href} target="_blank" rel="noopener noreferrer" className={linkCls}>
                    {l.label}
                  </a>
                </li>
              ) : (
                <li key={l.label}>
                  <Link href={l.href} className={linkCls}>{l.label}</Link>
                </li>
              ),
            )}
          </FooterCol>

          {/* "3 Day Event" used to sit here. The dates directly above it already
              say three days, so it was a row of type carrying no information. */}
          <FooterCol title="Event">
            <li className="flex items-start gap-2 text-neutral-600">
              <Calendar className="mt-0.5 h-4 w-4 shrink-0 text-[#cd2653]" />
              <span>11 to 13 December 2026</span>
            </li>
            <li className="flex items-start gap-2 text-neutral-600">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#cd2653]" />
              <span>Youngsfield Military Base<br />Wetton Road, Cape Town</span>
            </li>
          </FooterCol>

          {/* The single home for the address, email and phone. They previously
              appeared in both footers, in two different formats. */}
          <FooterCol title="Contact">
            <li>
              <a href="mailto:support@youngatheart.co.za" className={`flex items-start gap-2 ${linkCls}`}>
                <Mail className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="break-all">support@youngatheart.co.za</span>
              </a>
            </li>
            <li>
              <a href="tel:+27659435012" className={`flex items-center gap-2 ${linkCls}`}>
                <Phone className="h-4 w-4 shrink-0" />
                <span>+27&nbsp;65&nbsp;943&nbsp;5012</span>
              </a>
            </li>
          </FooterCol>
        </div>

        {/* ── Tier 2: the legal + payments strip FNB requires ───────────── */}
        <div className="border-t border-neutral-200 py-6">
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {LEGAL.map((l) => (
              <Link key={l.label} href={l.href} className={linkCls}>{l.label}</Link>
            ))}
          </nav>
          <p className="mt-3 text-xs leading-relaxed text-neutral-500">
            All transactions in South African Rand (ZAR). Operated and domiciled in South Africa.
            Card payments secured by FNB, Visa and Mastercard accepted.
          </p>
        </div>

        {/* ── Tier 3: attribution ──────────────────────────────────────── */}
        <div className="flex flex-col items-center justify-between gap-3 border-t border-neutral-200 py-6 sm:flex-row">
          <p className="text-sm text-neutral-500">
            © 2026 Young at Heart Festival. All rights reserved.
          </p>
          <ZaniiCredit surface="site" />
        </div>
      </div>
    </footer>
  )
}

const linkCls = 'text-neutral-600 hover:text-neutral-900 transition-colors'

function FooterCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-900">{title}</h4>
      <ul className="space-y-3 text-sm">{children}</ul>
    </div>
  )
}
