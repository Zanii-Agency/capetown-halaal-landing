'use client'

/**
 * "Made by Zanii", and the click counter behind it.
 *
 * Taona, 2026-07-27: "on the vendor portal they must see made by zanii and
 * anyone who clicks on it, including on the website, we must be notifed, I want
 * to track those numbers."
 *
 * The click writes a `zanii_click` row through the analytics endpoint that
 * already exists (/api/analytics/track -> site_events). No new endpoint, no new
 * table, and it inherits the session id, UTM and geo enrichment the pageview
 * path already does, so the numbers sit next to the rest of the site's traffic
 * instead of in a private corner.
 *
 * `surface` is what makes the number answerable: portal clicks and public-site
 * clicks are different audiences, and a single undifferentiated total would not
 * tell Taona which one is working.
 *
 * The navigation is NOT awaited. track() uses keepalive so the request survives
 * the page unload; blocking the link on a fetch would trade a real user's click
 * for a metric, which is the wrong way round.
 */

import { track } from '@/components/analytics-tracker'

export function ZaniiCredit({
  surface,
  className = '',
}: {
  surface: 'site' | 'portal'
  className?: string
}) {
  return (
    <a
      href="https://zanii.agency"
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => { void track('zanii_click', { metadata: { surface } }) }}
      className={`text-sm text-neutral-500 hover:text-neutral-900 transition-colors ${className}`}
    >
      Made by <span className="font-semibold">Zanii</span>
      <span className="text-[#cd2653]">.</span>
    </a>
  )
}
