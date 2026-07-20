import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'

// Logos live in the public vendor-assets bucket (same bucket + public-URL shape
// the exhibitor profile + marketing templates use). Law 2: a logo is a vendor's
// own public-facing brand asset, safe to surface; contact PII is never selected.
const LOGO_BUCKET = 'vendor-assets'
function publicLogoUrl(path: string | null | undefined): string | null {
  if (!path) return null
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${LOGO_BUCKET}/${path}`
}

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params
    const sectorName = SLUG_TO_SECTOR[slug]

    if (!sectorName) {
      return NextResponse.json({ error: 'Sector not found' }, { status: 404 })
    }

    const supabase = createAdminClient()

    const { data, error } = await supabase
      .from('vendor_applications')
      .select('id, business_name, business_description, website, instagram, admin_notes')
      .eq('status', 'approved')
      .contains('product_categories', [sectorName])
      .order('business_name', { ascending: true })

    if (error) {
      console.error('Sector query error:', error)
      return NextResponse.json({ vendors: [] })
    }

    type Row = {
      id: string
      business_name: string
      business_description: string | null
      website: string | null
      instagram: string | null
      admin_notes: string | null
    }

    const vendors = ((data || []) as Row[]).map((v) => {
      const profile = parsePortalState(v.admin_notes || '').profile || {}
      const logoUrl = publicLogoUrl(profile.logo_path)
      // has_profile mirrors the public detail-page gate (logo + a write-up):
      // only those vendors have a real /sectors/<slug>/<vendor> page, so the
      // list links to detail ONLY when complete (avoids dead 404 links).
      const writeUp = (profile.description || v.business_description || '').trim()
      return {
        id: v.id,
        business_name: v.business_name,
        business_description: v.business_description,
        website: profile.website || v.website || null,
        instagram: profile.instagram || v.instagram || null,
        logo_url: logoUrl,
        has_profile: Boolean(logoUrl && writeUp),
        // admin_notes is NEVER returned (Law 2) — parsed server-side only.
      }
    })

    // Vendors with a logo surface first so the grid leads with brand imagery,
    // then alphabetical (the query already ordered by name within each group).
    vendors.sort((a, b) => (a.logo_url ? 0 : 1) - (b.logo_url ? 0 : 1))

    // Edge-cache this PUBLIC, slow-changing list at Vercel's CDN so repeat
    // clicks are near-instant instead of re-running the Supabase query every
    // time. Served fresh for 2 min, then served stale (instant) for up to 10
    // more while it revalidates in the background. A newly uploaded logo shows
    // within ~2 min. No PII here (Law 2), so edge caching is safe.
    return NextResponse.json({ vendors }, {
      headers: {
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
      },
    })
  } catch (error) {
    console.error('Sector API error:', error)
    // Do not cache an error response.
    return NextResponse.json({ vendors: [] }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
