import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { requirePaid } from '@/lib/exhibitor-paygate'
import { PageShell, PageHeader, Card, Pill } from '@/components/chrome/PageChrome'
import { Download, Sparkles, Hash, Palette, Image as ImageIcon, FileDown, ExternalLink } from 'lucide-react'

export const dynamic = 'force-dynamic'

interface AssetCard {
  key: string
  label: string
  dims: string
  use: string
  href: string
  ratio: string
}

const ASSET_CARDS: AssetCard[] = [
  {
    key: 'ig-story',
    label: 'Instagram Story',
    dims: '1080 x 1920',
    use: 'Share to your IG / Facebook story. Tall vertical canvas.',
    href: '/api/exhibitor/portal/marketing/ig-story/png',
    ratio: 'aspect-[9/16]',
  },
  {
    key: 'ig-feed',
    label: 'Instagram Feed Post',
    dims: '1080 x 1080',
    use: 'Square post for the IG grid or a Facebook feed post.',
    href: '/api/exhibitor/portal/marketing/ig-feed/png',
    ratio: 'aspect-square',
  },
  {
    key: 'fb-post',
    label: 'Facebook Post',
    dims: '1200 x 630',
    use: 'Wide post or shared link preview on Facebook and LinkedIn.',
    href: '/api/exhibitor/portal/marketing/fb-post/png',
    ratio: 'aspect-[1200/630]',
  },
  {
    key: 'link-card',
    label: 'Find Us at CTH Card',
    dims: '1200 x 630',
    use: 'Drop in WhatsApp, email signatures, or as a link preview.',
    href: '/api/exhibitor/portal/marketing/link-card/png',
    ratio: 'aspect-[1200/630]',
  },
]

const BRAND_COLORS = [
  { name: 'Crimson', hex: '#cd2653', subtle: 'Primary brand colour. Buttons, badges, link accents.' },
  { name: 'Cream',   hex: '#F8F5EE', subtle: 'Soft background. Letting the logo breathe.' },
  { name: 'Charcoal', hex: '#1A1A1A', subtle: 'Headlines and high-contrast type.' },
]

const HASHTAGS = ['#YoungAtHeartFest', '#CapeTownHalaal', '#CTH2026', '#HalaalCapeTown', '#Youngsfield2026']

const HERO_IMAGES = [
  { src: '/about/festival-crowd.jpg', alt: 'Festival crowd at Youngsfield' },
  { src: '/about/festival-food.jpg', alt: 'Halaal festival food stall' },
  { src: '/gallery/gallery-3214.jpg', alt: 'Festival vendor stand' },
  { src: '/gallery/gallery-3367.jpg', alt: 'Festival atmosphere at golden hour' },
  { src: '/gallery/gallery-3412.jpg', alt: 'Live entertainment crowd shot' },
  { src: '/gallery/gallery-3450.jpg', alt: 'Festival vendor handing over food' },
]

const SUGGESTED_CAPTIONS = [
  {
    platform: 'Instagram',
    caption: "Come find us at Cape Town's biggest halaal festival, 11 to 13 December 2026 at Youngsfield Military Base. Three days of food, family, and a real Young at Heart vibe. Tickets at cthalaal.co.za.",
  },
  {
    platform: 'Facebook',
    caption: "We are exhibiting at the Young at Heart Festival this December! Visit us at Youngsfield Military Base from 11 to 13 December 2026. Tickets on sale now at cthalaal.co.za. See you there.",
  },
  {
    platform: 'TikTok',
    caption: "Cape Town halaal festival, three days of food and family. Youngsfield, 11 to 13 Dec. You already know where to find us.",
  },
  {
    platform: 'WhatsApp Status',
    caption: "Cape Town Halaal Festival starts 11 Dec. We are at Youngsfield. See you there. Tickets at cthalaal.co.za.",
  },
]

const BRAND_GUIDELINES = [
  { rule: 'Do not crop or distort the festival logo', detail: 'Always use the provided PNG or SVG files as-is.' },
  { rule: 'Keep the brand red as the primary accent', detail: 'Use #cd2653 for buttons, badges, links, headers.' },
  { rule: 'Use Fraunces for headings, Inter for body text', detail: 'These are the official festival typefaces.' },
  { rule: 'Do not place the logo on busy backgrounds', detail: 'Use the cream #F8F5EE or white as the backdrop.' },
  { rule: 'Keep the event dates and venue accurate', detail: 'Youngsfield Military Base, Ottery, 11-13 Dec 2026.' },
]

// Each banner points at a real render endpoint and advertises that render's
// TRUE dimensions. We only ship the four renders that exist (fb-post 1200x630,
// ig-feed 1080x1080, ig-story 1080x1920, link-card 1200x630), so every label,
// filename, and the bytes delivered all agree. No banner advertises a size we
// cannot actually produce.
const SOCIAL_BANNERS = [
  { label: 'Facebook / LinkedIn Banner', dims: '1200 x 630', href: '/api/exhibitor/portal/marketing/fb-post/png', file: 'social-fb-linkedin-banner.png' },
  { label: 'Instagram Square', dims: '1080 x 1080', href: '/api/exhibitor/portal/marketing/ig-feed/png', file: 'social-ig-square.png' },
]

export default async function MarketingPage() {
  await requirePaid()
  const ctx = await getExhibitorContext()
  const app = (ctx?.application as Record<string, unknown>) || {}
  const state = parsePortalState((app.admin_notes as string) || null)
  const stall = parseAllocation((app.admin_notes as string) || null).stall || 'TBA'
  const businessName = ((app.business_name as string) || 'Your stall').replace(/^DEMO\s*·?\s*/i, '')
  const hasLogo = Boolean(state.profile?.logo_path)

  return (
    <PageShell>
      <PageHeader
        kicker="Marketing kit"
        title="Tell people where to find you."
        subtitle="Download ready to share assets with your stall code baked in, plus the festival brand pack so your audience knows it is the real Cape Town Halaal."
      />

      <section className="mb-12">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#cd2653]" />
            <h2 className="font-serif text-2xl text-[#1B1A17]">Your auto-filled assets</h2>
          </div>
          <Pill tone="brand">Stall {stall}</Pill>
        </div>
        <p className="text-sm text-[#1B1A17]/60 mb-6 max-w-2xl">
          Every download below is rendered live with your business name, your stall code, and your logo. {hasLogo ? null : (
            <>Add your logo on the <a className="underline text-[#cd2653]" href="/exhibitor/portal/profile">Profile</a> page so it shows on the assets. The festival logo is used until you do.</>
          )}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {ASSET_CARDS.map((a) => (
            <Card key={a.key} className="flex flex-col">
              {/* Fixed-height thumbnail so the grid lines up regardless of the
                  asset's true aspect ratio (the real ratio is preserved only
                  for the actual download). A placeholder sits behind the image:
                  if the live render 500s the <img> paints nothing and this
                  neutral box with the asset title stays visible. */}
              <div className="relative w-full h-40 bg-[#F8F5EE] rounded-xl overflow-hidden border border-[#E5E5E5]/60 mb-4">
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-3 text-center pointer-events-none">
                  <ImageIcon className="w-5 h-5 text-[#1B1A17]/25" />
                  <span className="text-[11px] font-semibold text-[#1B1A17]/40 leading-tight">{a.label}</span>
                </div>
                <img
                  src={`${a.href}?preview=1`}
                  alt={`${a.label} preview`}
                  loading="lazy"
                  className="relative w-full h-full object-cover"
                />
              </div>
              <div className="mb-1 flex items-center justify-between">
                <h3 className="font-semibold text-[#1B1A17]">{a.label}</h3>
                <span className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#1B1A17]/50">{a.dims}</span>
              </div>
              <p className="text-xs text-[#1B1A17]/60 leading-relaxed mb-4 min-h-[2.5em]">{a.use}</p>
              <a
                href={a.href}
                download
                className="mt-auto inline-flex items-center justify-center gap-2 bg-[#cd2653] hover:bg-[#bf3026] text-white text-sm font-medium rounded-full px-4 py-2 transition-colors"
              >
                <Download className="w-4 h-4" />
                Download PNG
              </a>
            </Card>
          ))}
        </div>

        <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-xl flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ExternalLink className="w-5 h-5 text-blue-600 shrink-0" />
            <p className="text-sm text-blue-900">
              <strong>Edit on Canva.</strong> Use the official festival template to add your own photos, change colours, and create custom designs.
            </p>
          </div>
          <a
            href="https://www.canva.com/design/DAFoE4uQ4Lw/view"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-full px-4 py-2 transition-colors"
          >
            <ExternalLink className="w-4 h-4" /> Open Canva template
          </a>
        </div>
      </section>

      {/* Section 2: Social media banners */}
      <section className="mb-12">
        <div className="flex items-center gap-2 mb-4">
          <ImageIcon className="w-4 h-4 text-[#cd2653]" />
          <h2 className="font-serif text-2xl text-[#1B1A17]">Social media banners</h2>
        </div>
        <p className="text-sm text-[#1B1A17]/60 mb-6 max-w-2xl">
          Ready sized banners for your profile and cover images. These are pre-rendered with the festival branding.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {SOCIAL_BANNERS.map((b) => (
            <Card key={b.label} className="flex flex-col items-center gap-3 py-6">
              <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">{b.dims}</span>
              <h3 className="font-semibold text-[#1B1A17]">{b.label}</h3>
              <a
                href={b.href}
                download={b.file}
                className="inline-flex items-center gap-2 text-xs font-medium text-[#cd2653] hover:underline"
              >
                <Download className="w-3 h-3" /> Download
              </a>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2 mb-4">
          <Palette className="w-4 h-4 text-[#cd2653]" />
          <h2 className="font-serif text-2xl text-[#1B1A17]">Shared festival brand pack</h2>
        </div>
        <p className="text-sm text-[#1B1A17]/60 mb-6 max-w-2xl">
          Use these everywhere you talk about being at the festival. Same logos, same colours, same hashtags as the official accounts.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <ImageIcon className="w-4 h-4 text-[#cd2653]" />
              <h3 className="font-semibold text-[#1B1A17]">Festival logos</h3>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-[#F8F5EE] rounded-lg aspect-square flex items-center justify-center p-4">
                <img src="/logo.png" alt="CTH logo full colour" className="max-w-full max-h-full object-contain" />
              </div>
              <div className="bg-[#1A1A1A] rounded-lg aspect-square flex items-center justify-center p-4">
                <img src="/logo.png" alt="CTH logo on dark" className="max-w-full max-h-full object-contain invert" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <a href="/logo.png" download="CTH-logo.png" className="inline-flex items-center gap-2 text-xs font-medium text-[#cd2653] hover:underline">
                <Download className="w-3 h-3" /> Full colour PNG
              </a>
              <a href="/icon.svg" download="CTH-logo.svg" className="inline-flex items-center gap-2 text-xs font-medium text-[#cd2653] hover:underline">
                <Download className="w-3 h-3" /> Vector SVG
              </a>
              <a href="/icon-512.png" download="CTH-logo-square.png" className="inline-flex items-center gap-2 text-xs font-medium text-[#cd2653] hover:underline">
                <Download className="w-3 h-3" /> Square avatar PNG
              </a>
            </div>
          </Card>

          {/* Brand guidelines card */}
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <FileDown className="w-4 h-4 text-[#cd2653]" />
              <h3 className="font-semibold text-[#1B1A17]">Brand guidelines</h3>
            </div>
            <ul className="space-y-2.5">
              {BRAND_GUIDELINES.map((g) => (
                <li key={g.rule} className="text-sm">
                  <span className="text-[#cd2653] font-medium">• </span>
                  <span className="text-[#1B1A17]">{g.rule}</span>
                  <p className="text-[11px] text-[#1B1A17]/55 mt-0.5 ml-3">{g.detail}</p>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <div className="flex items-center gap-2 mb-3">
              <Hash className="w-4 h-4 text-[#cd2653]" />
              <h3 className="font-semibold text-[#1B1A17]">Hashtags and captions</h3>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {HASHTAGS.map((h) => (
                <code key={h} className="font-mono text-[11px] text-[#cd2653] bg-[#cd2653]/8 border border-[#cd2653]/15 px-2 py-1 rounded">
                  {h}
                </code>
              ))}
            </div>
            <div className="space-y-3 max-h-60 overflow-y-auto">
              {SUGGESTED_CAPTIONS.map((s) => (
                <div key={s.platform}>
                  <p className="text-[10px] text-[#1B1A17]/55 uppercase tracking-[0.16em] font-semibold mb-0.5">{s.platform}</p>
                  <p className="text-xs text-[#1B1A17]/80 leading-relaxed">{s.caption}</p>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card>
          <div className="flex items-center gap-2 mb-3">
            <ImageIcon className="w-4 h-4 text-[#cd2653]" />
            <h3 className="font-semibold text-[#1B1A17]">Festival hero photos</h3>
          </div>
          <p className="text-xs text-[#1B1A17]/55 mb-4">
            Generic festival shots you can pair with your own photos. Credit Cape Town Halaal where it makes sense.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {HERO_IMAGES.map((img) => (
              <a
                key={img.src}
                href={img.src}
                download
                className="group relative block aspect-square rounded-lg overflow-hidden bg-[#F8F5EE] border border-[#E5E5E5]/60"
              >
                <img
                  src={img.src}
                  alt={img.alt}
                  loading="lazy"
                  className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]"
                />
                <div className="absolute inset-0 bg-[#1A1A1A]/0 group-hover:bg-[#1A1A1A]/40 transition-colors flex items-end justify-end p-2">
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity bg-white text-[#1B1A17] text-[10px] font-bold uppercase tracking-[0.14em] px-2 py-1 rounded-full inline-flex items-center gap-1">
                    <Download className="w-3 h-3" /> Save
                  </span>
                </div>
              </a>
            ))}
          </div>
        </Card>

        <p className="text-xs text-[#1B1A17]/50 mt-6 max-w-3xl">
          A friendly note: please do not crop or recolour the festival logo, and keep the dates and venue accurate. {businessName} is the only business you can attach to these auto-filled assets, so they are safe to share anywhere.
        </p>
      </section>
    </PageShell>
  )
}
