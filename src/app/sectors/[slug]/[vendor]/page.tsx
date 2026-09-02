// CTH-DOCTRINE Law 2 (vendor-data-privacy). The public vendor profile MUST
// NOT render stall_code unless the vendor has explicitly opted-in via
// portalState.profile.publish_stall === true. Without an opt-in toggle in the
// UI yet, this defaults to FALSE — the "Stall {code}" badge will not appear
// for anyone until vendors get a publish toggle in their portal next sprint.
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { vendorSlug } from '@/lib/slugify'
import { parsePortalState, type VendorProfile } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { isPublicVendor } from '@/lib/public-vendor'

export const dynamic = 'force-dynamic'

const SLUG_TO_SECTOR: Record<string, { name: string; icon: string }> = {
  'food-beverage': { name: 'Food & Beverage', icon: '🍽️' },
  'fashion-modest-wear': { name: 'Fashion & Modest Wear', icon: '👗' },
  'beauty-wellness': { name: 'Beauty & Wellness', icon: '✨' },
  'health-pharmacy': { name: 'Health & Pharmacy', icon: '💊' },
  'travel-tourism': { name: 'Travel & Tourism', icon: '✈️' },
  'home-living': { name: 'Home & Living', icon: '🏠' },
  'finance-services': { name: 'Finance & Services', icon: '💼' },
  'business-trade': { name: 'Business & Trade', icon: '🏢' },
}

async function fetchVendor(sectorSlug: string, vendorSlugParam: string) {
  const sector = SLUG_TO_SECTOR[sectorSlug]
  if (!sector) return null
  const db = createAdminClient()
  const { data } = await db
    .from('vendor_applications')
    .select('id, business_name, business_description, website, instagram, facebook, admin_notes, paid_at')
    .eq('status', 'approved')
    .contains('product_categories', [sector.name])
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
  if (!match) return null
  const portal = parsePortalState(match.admin_notes || '')
  const alloc = parseAllocation(match.admin_notes || '')
  const profile = portal.profile || {}
  const writeUp = (profile.description || match.business_description || '').trim()
  const hasLogo = Boolean(profile.logo_path)
  if (!writeUp || !hasLogo) return null

  // Resolve signed URLs for logo + gallery (vendor-assets bucket).
  let logoUrl: string | null = null
  if (profile.logo_path) {
    const { data: sig } = await db.storage.from('vendor-assets').createSignedUrl(profile.logo_path, 3600)
    logoUrl = sig?.signedUrl || null
  }
  const galleryUrls: string[] = []
  for (const p of profile.photo_gallery || []) {
    const { data: sig } = await db.storage.from('vendor-assets').createSignedUrl(p, 3600)
    if (sig?.signedUrl) galleryUrls.push(sig.signedUrl)
  }

  // Law 2: stall_code only when allocated AND publish_stall opt-in is true.
  const publishStall = Boolean(
    (profile as VendorProfile & { publish_stall?: boolean }).publish_stall,
  )
  const stallCode = alloc.status === 'allocated' && publishStall ? alloc.stall : null

  return {
    business_name: match.business_name,
    tagline: profile.tagline || null,
    write_up: writeUp,
    menu: profile.menu || [],
    logo_url: logoUrl,
    gallery_urls: galleryUrls,
    stall_code: stallCode,
    website: profile.website || match.website,
    instagram: profile.instagram || match.instagram,
    facebook: profile.facebook || match.facebook,
    sector,
    sector_slug: sectorSlug,
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string; vendor: string }> }) {
  const { slug, vendor } = await params
  const v = await fetchVendor(slug, vendor)
  if (!v) return { title: 'Vendor not found' }
  return {
    title: `${v.business_name}, Young at Heart Festival 2026`,
    description: v.write_up.slice(0, 160),
  }
}

export default async function VendorProfilePage({
  params,
}: {
  params: Promise<{ slug: string; vendor: string }>
}) {
  const { slug, vendor } = await params
  const v = await fetchVendor(slug, vendor)
  if (!v) notFound()

  return (
    <main className="min-h-screen bg-[#fafaf7] text-neutral-900">
      {/* Breadcrumb */}
      <div className="max-w-5xl mx-auto px-6 pt-10 text-sm">
        <Link href="/#sectors" className="text-neutral-500 hover:text-neutral-900">Sectors</Link>
        <span className="text-neutral-300 mx-2">/</span>
        <Link href={`/sectors/${v.sector_slug}`} className="text-neutral-500 hover:text-neutral-900">{v.sector.name}</Link>
        <span className="text-neutral-300 mx-2">/</span>
        <span className="text-neutral-900">{v.business_name}</span>
      </div>

      {/* Header band */}
      <div className="max-w-5xl mx-auto px-6 pt-10 pb-12">
        <div className="flex flex-col md:flex-row gap-8 items-start">
          {v.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={v.logo_url}
              alt={`${v.business_name} logo`}
              className="w-32 h-32 md:w-44 md:h-44 rounded-2xl object-contain bg-white border border-neutral-200 shadow-sm"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-600 bg-white border border-neutral-200 rounded-full px-3 py-1">
                <span>{v.sector.icon}</span> {v.sector.name}
              </span>
              {v.stall_code && (
                <span className="inline-flex items-center text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                  Stall {v.stall_code}
                </span>
              )}
            </div>
            <h1 className="text-3xl md:text-5xl font-serif leading-tight tracking-tight text-neutral-900 mb-2" style={{ fontFamily: '"Fraunces", Georgia, serif' }}>
              {v.business_name}
            </h1>
            {v.tagline && <p className="text-lg text-neutral-600 mb-4">{v.tagline}</p>}
            <div className="flex flex-wrap items-center gap-3 mt-4">
              {v.website && (
                <a href={v.website} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-neutral-700 hover:text-neutral-900 underline">
                  Website
                </a>
              )}
              {v.instagram && (
                <a href={`https://instagram.com/${v.instagram.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-neutral-700 hover:text-neutral-900 underline">
                  Instagram
                </a>
              )}
              {v.facebook && (
                <a href={v.facebook.startsWith('http') ? v.facebook : `https://facebook.com/${v.facebook}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-neutral-700 hover:text-neutral-900 underline">
                  Facebook
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Write-up */}
      <section className="max-w-3xl mx-auto px-6 pb-12">
        <h2 className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-3">About</h2>
        <div className="text-base leading-relaxed text-neutral-800 whitespace-pre-wrap">{v.write_up}</div>
      </section>

      {/* Menu items / products */}
      {v.menu.length > 0 && (
        <section className="max-w-3xl mx-auto px-6 pb-12">
          <h2 className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-3">
            {v.sector.name === 'Food & Beverage' ? 'On the Menu' : 'What We Bring'}
          </h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {v.menu.map((item, i) => (
              <li key={i} className="bg-white border border-neutral-200 rounded-lg px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-base text-neutral-900 font-medium">{item.name}</span>
                  {item.price && <span className="text-sm text-neutral-500 whitespace-nowrap">{item.price}</span>}
                </div>
                {item.desc && <p className="text-sm text-neutral-500 mt-1">{item.desc}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Gallery */}
      {v.gallery_urls.length > 0 && (
        <section className="max-w-5xl mx-auto px-6 pb-16">
          <h2 className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-3">Gallery</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {v.gallery_urls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={url} alt={`${v.business_name} photo ${i + 1}`}
                className="w-full aspect-[4/3] object-cover rounded-xl bg-neutral-100" />
            ))}
          </div>
        </section>
      )}

      {/* Footer band */}
      <div className="border-t border-neutral-200 mt-8">
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-neutral-500">
          <Link href={`/sectors/${v.sector_slug}`} className="hover:text-neutral-900">
            ← More {v.sector.name} vendors
          </Link>
          <Link href="https://tickets.youngatheart.co.za" className="text-[#cd2653] hover:underline font-medium">
            Get festival tickets →
          </Link>
        </div>
      </div>
    </main>
  )
}
