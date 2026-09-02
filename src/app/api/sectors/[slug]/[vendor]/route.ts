import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { vendorSlug } from '@/lib/slugify'
import { parsePortalState, type VendorProfile } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { isPublicVendor } from '@/lib/public-vendor'

// Sector slug → product_categories label, same map as the parent /api/sectors/[slug].
const SLUG_TO_SECTOR: Record<string, string> = {
  'food-beverage': 'Food & Beverage',
  'fashion-modest-wear': 'Fashion & Modest Wear',
  'beauty-wellness': 'Beauty & Wellness',
  'health-pharmacy': 'Health & Pharmacy',
  'travel-tourism': 'Travel & Tourism',
  'home-living': 'Home & Living',
  'finance-services': 'Finance & Services',
  'business-trade': 'Business & Trade',
}

/**
 * GET /api/sectors/<sector>/<vendor-slug>
 *
 * Returns the PUBLIC view of one vendor. Doctrine Law 2: never expose
 * contact_person, email, phone, address, admin_notes, payment data.
 *
 * Publication gate (must all be true):
 *  - status = 'approved'
 *  - vendor IS in this sector (product_categories contains the sector label)
 *  - profile has a logo path stored
 *  - profile has a write-up (long_description OR fall back to business_description)
 *
 * Stall-code gate (CTH-DOCTRINE Law 2):
 *  - stall_code is returned ONLY when:
 *      (a) parseAllocation(admin_notes).status === 'allocated' AND
 *      (b) portalState.profile.publish_stall === true
 *  - publish_stall is an opt-in flag (default false). Without it, stall_code
 *    is OMITTED from the public payload. Vendors should not have their stall
 *    location surfaced publicly without explicit consent.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; vendor: string }> },
) {
  const { slug, vendor: vendorSlugParam } = await params
  const sectorName = SLUG_TO_SECTOR[slug]
  if (!sectorName) return NextResponse.json({ error: 'Sector not found' }, { status: 404 })

  const db = createAdminClient()
  const { data, error } = await db
    .from('vendor_applications')
    .select('id, business_name, business_description, website, instagram, facebook, admin_notes, paid_at')
    .eq('status', 'approved')
    .contains('product_categories', [sectorName])
  if (error) return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })

  type Row = {
    id: string
    business_name: string
    business_description: string | null
    website: string | null
    instagram: string | null
    facebook: string | null
    admin_notes: string | null
    paid_at: string | null
  }
  const match = ((data || []) as Row[])
    .filter((v) => isPublicVendor({ admin_notes: v.admin_notes, paid_at: v.paid_at }))
    .find((v) => vendorSlug(v.business_name) === vendorSlugParam)
  if (!match) return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })

  const portal = parsePortalState(match.admin_notes || '')
  const alloc = parseAllocation(match.admin_notes || '')
  const profile = portal.profile || {}
  const writeUp = (profile.description || match.business_description || '').trim()
  const hasLogo = Boolean(profile.logo_path)
  if (!writeUp || !hasLogo) {
    // Profile is approved but vendor hasn't completed it. Publication gate.
    return NextResponse.json({ error: 'Profile incomplete' }, { status: 404 })
  }

  // Law 2: stall_code requires explicit vendor opt-in via publish_stall on
  // the portal profile. Optional-chained → undefined defaults to false.
  const publishStall = Boolean(
    (profile as VendorProfile & { publish_stall?: boolean }).publish_stall,
  )
  const stallCode = alloc.status === 'allocated' && publishStall ? alloc.stall : null

  // Public payload: deliberately omits contact_person, email, phone, address,
  // payment_status, admin_notes raw, per Doctrine Law 2.
  return NextResponse.json({
    vendor: {
      slug: vendorSlugParam,
      business_name: match.business_name,
      tagline: profile.tagline || null,
      write_up: writeUp,
      menu: profile.menu || [],
      photo_gallery: profile.photo_gallery || [],
      logo_path: profile.logo_path || null,
      stall_code: stallCode,
      website: profile.website || match.website || null,
      instagram: profile.instagram || match.instagram || null,
      facebook: profile.facebook || match.facebook || null,
      sector: sectorName,
      sector_slug: slug,
    },
  })
}
