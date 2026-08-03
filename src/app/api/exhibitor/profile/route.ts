import { NextRequest, NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, parsePortalState, type VendorProfile } from '@/lib/portal-state'
import { vendorSlug } from '@/lib/slugify'
import { stripAllHtml } from '@/lib/sanitize'
import { recordVendorAction } from '@/lib/vendor-action-log'

const BUCKET = 'vendor-assets'
const MAX_LOGO_BYTES = 5 * 1024 * 1024       // 5MB
const MAX_GALLERY_BYTES = 8 * 1024 * 1024    // 8MB per photo
const MAX_GALLERY_PHOTOS = 8                 // cap gallery size
const ACCEPT_IMAGE = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']

// SECTORS taxonomy — single source of truth, mirrored in /apply form +
// SectorsSection + /sectors/[slug]. Vendors don't change sector in portal
// (locked at apply time); admin handles re-categorisation.
const SECTOR_TO_SLUG: Record<string, string> = {
  'Food & Beverage': 'food-beverage',
  'Fashion & Modest Wear': 'fashion-modest-wear',
  'Beauty & Wellness': 'beauty-wellness',
  'Health & Pharmacy': 'health-pharmacy',
  'Travel & Tourism': 'travel-tourism',
  'Home & Living': 'home-living',
  'Finance & Services': 'finance-services',
  'Business & Trade': 'business-trade',
}

function publicUrl(path: string): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
}

function publicProfileUrl(productCategories: unknown, businessName: string): string | null {
  const cats = Array.isArray(productCategories) ? (productCategories as string[]) : []
  const sectorLabel = cats.find((c) => SECTOR_TO_SLUG[c])
  if (!sectorLabel) return null
  return `https://cthalaal.co.za/sectors/${SECTOR_TO_SLUG[sectorLabel]}/${vendorSlug(businessName)}`
}

// GET: current profile + publication status + sector lock.
export async function GET() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const app = ctx.application as Record<string, unknown>
  const state = parsePortalState(app.admin_notes as string)
  const p = state.profile || {}
  const businessName = (app.business_name as string) || ''
  const writeUp = p.description ?? (app.business_description as string) ?? ''
  const hasLogo = Boolean(p.logo_path)
  const hasWriteUp = Boolean(writeUp.trim())
  const isApproved = app.status === 'approved'
  const liveUrl = publicProfileUrl(app.product_categories, businessName)
  const publicCategory = (Array.isArray(app.product_categories) ? (app.product_categories as string[]).find((c) => SECTOR_TO_SLUG[c]) : null)

  return NextResponse.json({
    profile: {
      business_name: businessName,
      tagline: p.tagline ?? '',
      description: writeUp,
      website: p.website ?? (app.website as string) ?? '',
      instagram: p.instagram ?? (app.instagram as string) ?? '',
      facebook: p.facebook ?? (app.facebook as string) ?? '',
      menu: p.menu ?? [],
      logo_url: p.logo_path ? publicUrl(p.logo_path) : null,
      gallery_urls: (p.photo_gallery || []).map((path) => ({ path, url: publicUrl(path) })),
      sector: publicCategory,
    },
    publication: {
      is_live: isApproved && hasLogo && hasWriteUp,
      is_approved: isApproved,
      has_logo: hasLogo,
      has_write_up: hasWriteUp,
      live_url: isApproved && hasLogo && hasWriteUp ? liveUrl : null,
      preview_url: liveUrl,  // always available as a preview link
    },
  })
}

// POST handles 3 shapes:
//  - multipart with 'logo' field      → upload/replace logo
//  - multipart with 'gallery' field   → append one gallery photo
//  - JSON                              → update tagline/description/socials/menu
//
// DELETE handles one shape:
//  - JSON { gallery_path: '<bucket path>' } → remove that path from the gallery
export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const applicationId = ctx.application.id as string
  const contentType = req.headers.get('content-type') || ''

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: 'Bad form' }, { status: 400 })

    const logo = form.get('logo')
    if (logo instanceof File) {
      if (logo.size > MAX_LOGO_BYTES) return NextResponse.json({ error: 'Logo too large (max 5MB)' }, { status: 400 })
      if (!ACCEPT_IMAGE.includes(logo.type)) return NextResponse.json({ error: 'Logo must be PNG, JPG, or WebP' }, { status: 400 })
      const ext = (logo.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')
      const path = `${applicationId}/logo-${Date.now()}.${ext}`
      const admin = createAdminClient()
      const { error } = await admin.storage.from(BUCKET).upload(path, Buffer.from(await logo.arrayBuffer()), {
        contentType: logo.type, upsert: true,
      })
      if (error) return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
      await updatePortalState(applicationId, (s) => ({ ...s, profile: { ...(s.profile || {}), logo_path: path } }))
      await recordVendorAction({ applicationId, eventType: 'profile_logo_uploaded', actorEmail: ctx.email, afterValue: path })
      return NextResponse.json({ success: true, logo_url: publicUrl(path) })
    }

    const gallery = form.get('gallery')
    if (gallery instanceof File) {
      if (gallery.size > MAX_GALLERY_BYTES) return NextResponse.json({ error: 'Photo too large (max 8MB each)' }, { status: 400 })
      if (!ACCEPT_IMAGE.includes(gallery.type)) return NextResponse.json({ error: 'Photo must be PNG, JPG, or WebP' }, { status: 400 })
      // Cap gallery size — check current count before adding.
      const ctx2 = await getExhibitorContext()
      const state = parsePortalState((ctx2?.application?.admin_notes as string) || '')
      const current = state.profile?.photo_gallery || []
      if (current.length >= MAX_GALLERY_PHOTOS) {
        return NextResponse.json({ error: `Gallery full (max ${MAX_GALLERY_PHOTOS} photos). Remove one to add another.` }, { status: 400 })
      }
      const ext = (gallery.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
      const path = `${applicationId}/gallery-${Date.now()}-${current.length}.${ext}`
      const admin = createAdminClient()
      const { error } = await admin.storage.from(BUCKET).upload(path, Buffer.from(await gallery.arrayBuffer()), {
        contentType: gallery.type, upsert: true,
      })
      if (error) return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
      await updatePortalState(applicationId, (s) => ({
        ...s,
        profile: { ...(s.profile || {}), photo_gallery: [...(s.profile?.photo_gallery || []), path] },
      }))
      await recordVendorAction({ applicationId, eventType: 'profile_gallery_photo_added', actorEmail: ctx.email, afterValue: path })
      return NextResponse.json({ success: true, path, url: publicUrl(path) })
    }

    return NextResponse.json({ error: 'No file in form' }, { status: 400 })
  }

  // JSON path — text fields + menu
  const body = await req.json().catch(() => ({}))
  // V2: strip ALL HTML tags from anything that renders on the public sector
  // page. CSP is Report-Only here so script tags would actually execute. We
  // discard tags entirely (no allowed tags, no allowed attrs).
  const clean: Partial<VendorProfile> = {
    tagline: stripAllHtml(String(body.tagline || '')).slice(0, 120),
    description: stripAllHtml(String(body.description || '')).slice(0, 2200),   // ~350 words hard cap
    website: String(body.website || '').slice(0, 200),
    instagram: String(body.instagram || '').slice(0, 120),
    facebook: String(body.facebook || '').slice(0, 200),
    menu: Array.isArray(body.menu)
      ? body.menu.slice(0, 40).map((m: { name?: string; price?: string; desc?: string }) => ({
          name: stripAllHtml(String(m.name || '')).slice(0, 80),
          price: stripAllHtml(String(m.price || '')).slice(0, 30),
          desc: stripAllHtml(String(m.desc || '')).slice(0, 200),
        })).filter((m: { name: string }) => m.name)
      : [],
  }
  const next = await updatePortalState(applicationId, (s) => ({
    ...s,
    profile: { ...(s.profile || {}), ...clean },
  }))
  await recordVendorAction({ applicationId, eventType: 'profile_updated', actorEmail: ctx.email, note: Object.keys(clean).join(', ') })
  return NextResponse.json({ success: true, profile: next.profile })
}

export async function DELETE(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const applicationId = ctx.application.id as string
  const body = await req.json().catch(() => ({}))
  const galleryPath = String(body.gallery_path || '')
  if (!galleryPath || !galleryPath.startsWith(`${applicationId}/`)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }
  const admin = createAdminClient()
  await admin.storage.from(BUCKET).remove([galleryPath]).catch(() => null)
  await updatePortalState(applicationId, (s) => ({
    ...s,
    profile: {
      ...(s.profile || {}),
      photo_gallery: (s.profile?.photo_gallery || []).filter((p) => p !== galleryPath),
    },
  }))
  return NextResponse.json({ success: true })
}
