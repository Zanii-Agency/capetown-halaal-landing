// Resolve the vendor's marketing fields from the signed-in session.
//
// SECURITY (CTH-DOCTRINE Law 2 vendor-data-privacy):
//   This module is the ONE place that touches vendor data for marketing
//   renders. It pulls the application row via getExhibitorContext (which
//   refuses email-fallback joins) and never reads a vendor id from a query
//   string. Callers in route handlers MUST go through this helper.
//
// Falls back to the festival logo when the vendor has not uploaded one yet,
// so the auto-filled assets still look complete on day one.

import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { escapeHtml } from '@/lib/marketing/png-renderer'

export interface VendorMarketingFields {
  business_name: string
  stall_code: string
  logo_url: string
  tagline: string
  // logo_block is the resolved markup that the templates render where the raw
  // <img> used to live: either the vendor's logo <img>, or a monogram fallback
  // when no logo was uploaded (so a vendor with no logo never renders as an
  // empty white box). Filled per-template by resolveVendorMarketingFields().
  logo_block: string
  [key: string]: string
}

const FALLBACK_STALL = 'TBA'
const FALLBACK_TAGLINE = 'Cape Town’s biggest halaal festival, 11 to 13 December 2026.'

/**
 * Resolve the public URL for a vendor-uploaded logo. Returns null when the
 * vendor has not uploaded one (or storage is misconfigured) so callers can
 * fall back to a monogram instead of a broken/empty image box.
 */
function publicLogoUrl(logo_path: string | undefined): string | null {
  if (!logo_path) return null
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return null
  return `${base}/storage/v1/object/public/vendor-assets/${logo_path}`
}

/**
 * Derive 1-2 uppercase initials from a business name for the monogram.
 * Rule: first letters of the first two words; if only one word, its first
 * two letters; strips HTML entities (the name arrives HTML-escaped) and any
 * non-letter/digit so something like "&amp; Co" never leaks an entity char.
 * Always returns at least one character, falling back to "C" (Cape Town).
 */
export function deriveInitials(escapedBusinessName: string): string {
  // The name is already HTML-escaped, so decode entities back to plain text
  // before slicing, otherwise "&amp;" would contribute "A" to the monogram.
  const plain = escapedBusinessName
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  const words = plain
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
  let initials: string
  if (words.length >= 2) {
    initials = (words[0][0] + words[1][0])
  } else if (words.length === 1) {
    initials = words[0].slice(0, 2)
  } else {
    initials = 'C'
  }
  return escapeHtml(initials.toUpperCase())
}

// Per-template monogram font size, tuned to read as a confident display
// monogram inside that template's existing logo box. The monogram fills the
// parent frame the template already provides (.right / .logo-frame), so the
// box dimensions, radius and position stay identical to a real logo render and
// the layout never shifts. We only paint a cream backdrop + the serif initials.
const MONOGRAM_FONT_SIZE: Record<string, number> = {
  'ig-story': 150, // 320x320 frame
  'ig-feed':  240, // fills the tall right column
  'fb-post':  140, // 280x280 frame
  'link-card':190, // 360x360 frame
}

/**
 * Build the {{logo_block}} markup for one template. When the vendor uploaded a
 * logo we emit the same <img> the templates used before. Otherwise we emit a
 * pure inline-styled monogram (cream backdrop, pink serif initials) that FILLS
 * the template's existing logo frame, so the layout footprint is identical and
 * there is never an empty white box. All styling is inline so the headless
 * render is self-contained (no external asset can fail to load).
 */
function buildLogoBlock(
  template: string,
  logoUrl: string | null,
  initials: string,
): string {
  const fontSize = MONOGRAM_FONT_SIZE[template] ?? MONOGRAM_FONT_SIZE['ig-feed']
  // Always render the monogram as a base layer filling the logo frame. When the
  // vendor has a logo we overlay the <img> on top; if that image fails to load
  // (no logo_path, or a logo_path whose file is missing/blank in storage, which
  // is the common case), the <img> hides itself via onerror and the monogram
  // shows through. This means a missing/broken logo NEVER renders as an empty
  // white box, regardless of whether the path is absent or just unreachable.
  const monogram =
    `<div style="position:absolute;inset:0;background:#FAF7F2;` +
    `display:flex;align-items:center;justify-content:center;overflow:hidden;">` +
    `<span style="font-family:'Fraunces',Georgia,serif;font-weight:700;` +
    `font-size:${fontSize}px;line-height:1;color:#cd2653;` +
    `letter-spacing:0.01em;">${initials}</span>` +
    `</div>`
  // The overlay starts hidden and only reveals itself once it has successfully
  // loaded. A broken/missing logo file never reveals, so the monogram beneath
  // stays visible. (The renderer waits for images via addEventListener, so these
  // inline handlers are preserved, not clobbered.)
  const overlay = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="" ` +
      `style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;" ` +
      `onload="this.style.display='block'" onerror="this.style.display='none'"/>`
    : ''
  return `<div style="position:relative;width:100%;height:100%;overflow:hidden;">${monogram}${overlay}</div>`
}

/**
 * Resolve marketing fields for the currently signed-in vendor.
 * Returns null when no vendor session is active (route handler returns 401).
 * All returned strings are HTML-escaped and safe to inject into the templates.
 *
 * The `template` argument lets us build a {{logo_block}} sized to that
 * template's logo box: the real logo <img> when the vendor uploaded one, or a
 * brand monogram fallback otherwise (never an empty white box).
 */
export async function resolveVendorMarketingFields(
  template: string,
): Promise<VendorMarketingFields | null> {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return null
  const app = ctx.application as Record<string, unknown>
  const state = parsePortalState((app.admin_notes as string) || null)
  const stallCode = parseAllocation((app.admin_notes as string) || null).stall || FALLBACK_STALL
  const profile = state.profile || {}

  const rawName = ((app.business_name as string) || ctx.email || 'Your Stall').replace(/^DEMO\s*·?\s*/i, '').trim()
  const rawTag = (profile.tagline as string) || (profile.description as string) || FALLBACK_TAGLINE
  // Keep the tagline short so it never overflows the template.
  const trimmedTag = rawTag.length > 110 ? rawTag.slice(0, 107).trimEnd() + '...' : rawTag

  const businessName = escapeHtml(rawName)
  const logoUrl = publicLogoUrl(profile.logo_path)
  const initials = deriveInitials(businessName)

  return {
    business_name: businessName,
    stall_code: escapeHtml(stallCode),
    // logo_url kept for backwards-compat / debugging; templates now use
    // logo_block. Empty string when the vendor uploaded no logo.
    logo_url: logoUrl || '',
    tagline: escapeHtml(trimmedTag),
    logo_block: buildLogoBlock(template, logoUrl, initials),
  }
}

/** Filename-safe slug from the vendor's business name. */
export function vendorFilenameSlug(businessName: string): string {
  return businessName
    .replace(/&[a-z]+;/gi, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'vendor'
}
