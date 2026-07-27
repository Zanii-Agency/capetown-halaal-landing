/**
 * Which routes get the public site chrome (the marketing footer).
 *
 * The footer is mounted in the ROOT layout, so without this it renders on every
 * route in the app — including the admin console and the exhibitor portal, both
 * of which are fixed-height application shells (`md:h-screen md:overflow-hidden`
 * in app/(admin)/admin/layout.tsx, `lg:h-screen` in exhibitor/portal/layout.tsx).
 * A four-column marketing footer with "Apply as Vendor" and "Buy Tickets" bolted
 * under a logged-in operator's dashboard is wrong on both counts: it is noise to
 * the wrong audience, and it adds scroll to a shell built not to have any.
 *
 * The predecessor (SiteLegalFooter) had the same global mount and the same flaw;
 * it was merely small enough that nobody noticed a legal strip under the admin
 * login. Replacing it with a much larger footer is what made this visible.
 *
 * Kept as a pure function rather than inlined so the rule is testable without
 * rendering Next.js, and so the list of private prefixes has ONE home. Both
 * private areas ship their own chrome: the portal has its own Zanii credit, and
 * the admin console has its own shell.
 */

/** Route prefixes that are private application surfaces, not the public site. */
const PRIVATE_PREFIXES = ['/admin', '/exhibitor'] as const

export function showsSiteFooter(pathname: string | null | undefined): boolean {
  if (!pathname) return true
  // Match on a path SEGMENT, so a future public route like /administration or
  // /exhibitors (plural, a public directory) is not swallowed by the prefix.
  return !PRIVATE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}
