import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import ProfileEditor from '@/components/exhibitor/ProfileEditor'
import { vendorSlug } from '@/lib/slugify'
import { requirePaid } from '@/lib/exhibitor-paygate'
import {
  PageShell, PageHeader, Card
} from '@/components/chrome/PageChrome'

export const dynamic = 'force-dynamic'

const SECTOR_TO_SLUG: Record<string, string> = {
  'Food & Beverage': 'food-beverage',
  'Fashion & Modest Wear': 'fashion-modest-wear',
  'Beauty & Wellness': 'beauty-wellness',
  'Health & Pharmacy': 'health-pharmacy',
  'Travel & Tourism': 'travel-tourism',
  'Home & Living': 'home-living',
  'Finance & Services': 'finance-services',
  'Business & Trade': 'business-trade',
  'Other': 'other',
}

function publicUrl(path: string): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/vendor-assets/${path}`
}

export default async function ProfilePage() {
  await requirePaid()
  const ctx = await getExhibitorContext()
  const app = ctx?.application as Record<string, unknown> | undefined
  const state = parsePortalState(app?.admin_notes as string)
  const p = state.profile || {}
  const businessName = (app?.business_name as string) || ''
  const writeUp = p.description ?? (app?.business_description as string) ?? ''

  const cats = Array.isArray(app?.product_categories) ? (app!.product_categories as string[]) : []
  const sectorLabel = cats.find((c) => SECTOR_TO_SLUG[c]) || null
  const sectorSlug = sectorLabel ? SECTOR_TO_SLUG[sectorLabel] : null
  const previewUrl = sectorSlug ? `https://cthalaal.co.za/sectors/${sectorSlug}/${vendorSlug(businessName)}` : null

  const initial = {
    business_name: businessName,
    tagline: p.tagline ?? '',
    description: writeUp,
    website: p.website ?? (app?.website as string) ?? '',
    instagram: p.instagram ?? (app?.instagram as string) ?? '',
    facebook: p.facebook ?? (app?.facebook as string) ?? '',
    menu: p.menu ?? [],
    logo_url: p.logo_path ? publicUrl(p.logo_path) : null,
    gallery_urls: (p.photo_gallery || []).map((path) => ({ path, url: publicUrl(path) })),
    sector: sectorLabel,
  }

  const hasLogo = Boolean(p.logo_path)
  const hasWriteUp = Boolean(writeUp.trim())
  const isApproved = app?.status === 'approved'
  const publication = {
    is_live: Boolean(isApproved && hasLogo && hasWriteUp),
    is_approved: Boolean(isApproved),
    has_logo: hasLogo,
    has_write_up: hasWriteUp,
    live_url: isApproved && hasLogo && hasWriteUp ? previewUrl : null,
    preview_url: previewUrl,
  }

  return (
    <PageShell>
      <Card className="max-w-3xl mx-auto">
        <PageHeader
          kicker="Profile"
          title={businessName}
          subtitle={`This is what festival-goers see when they browse ${sectorLabel || 'your sector'} vendors.`}
        />
        <ProfileEditor initial={initial} publication={publication} />
      </Card>
    </PageShell>
  )
}