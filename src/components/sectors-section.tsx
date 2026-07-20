'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence, useInView } from 'framer-motion'
import {
  Utensils, ShoppingBag, Heart, Sparkles,
  Building, Plane, Home, Briefcase,
  X, Loader2, Globe, Instagram, MapPin,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const sectors = [
  {
    icon: Utensils,
    title: 'Food & Beverage',
    slug: 'food-beverage',
    description: 'Restaurants, catering, food products & ingredients',
    color: 'from-red-500 to-orange-500',
    bgGlow: 'rgba(239, 68, 68, 0.2)',
    count: '120+'
  },
  {
    icon: ShoppingBag,
    title: 'Fashion & Modest Wear',
    slug: 'fashion-modest-wear',
    description: 'Clothing, accessories, hijabs & modest fashion',
    color: 'from-purple-500 to-pink-500',
    bgGlow: 'rgba(168, 85, 247, 0.2)',
    count: '80+'
  },
  {
    icon: Sparkles,
    title: 'Beauty & Wellness',
    slug: 'beauty-wellness',
    description: 'Cosmetics, skincare & wellness products',
    color: 'from-pink-500 to-rose-500',
    bgGlow: 'rgba(236, 72, 153, 0.2)',
    count: '60+'
  },
  {
    icon: Heart,
    title: 'Health & Pharmacy',
    slug: 'health-pharmacy',
    description: 'Supplements, medicine & health products',
    color: 'from-emerald-500 to-teal-500',
    bgGlow: 'rgba(16, 185, 129, 0.2)',
    count: '40+'
  },
  {
    icon: Plane,
    title: 'Travel & Tourism',
    slug: 'travel-tourism',
    description: 'Travel agencies, destinations & experiences',
    color: 'from-blue-500 to-cyan-500',
    bgGlow: 'rgba(59, 130, 246, 0.2)',
    count: '35+'
  },
  {
    icon: Home,
    title: 'Home & Living',
    slug: 'home-living',
    description: 'Furniture, decor & home essentials',
    color: 'from-amber-500 to-yellow-500',
    bgGlow: 'rgba(245, 158, 11, 0.2)',
    count: '45+'
  },
  {
    icon: Briefcase,
    title: 'Finance & Services',
    slug: 'finance-services',
    description: 'Islamic banking, takaful & financial services',
    color: 'from-slate-500 to-zinc-500',
    bgGlow: 'rgba(100, 116, 139, 0.2)',
    count: '25+'
  },
  {
    icon: Building,
    title: 'Business & Trade',
    slug: 'business-trade',
    description: 'B2B services, suppliers & trade opportunities',
    color: 'from-indigo-500 to-violet-500',
    bgGlow: 'rgba(99, 102, 241, 0.2)',
    count: '30+'
  }
]

type Sector = typeof sectors[number]

interface VendorLite {
  id: string
  business_name: string
  business_description: string | null
  website: string | null
  instagram: string | null
  logo_url: string | null
  has_profile: boolean
}

interface MenuItem { name: string; price?: string; desc?: string }

interface VendorFull {
  slug: string
  business_name: string
  tagline?: string | null
  write_up: string
  menu: MenuItem[]
  photo_gallery: string[]
  logo_url?: string | null
  logo_path?: string | null
  stall_code?: string | null
  website?: string | null
  instagram?: string | null
  facebook?: string | null
  sector: string
}

function slugifyName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80)
}

function SectorCard({ sector, index, liveCount, active, onClick }: { sector: Sector; index: number; liveCount: number | null; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-50px' })

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40, rotateX: -10 }}
      animate={isInView ? { opacity: 1, y: 0, rotateX: 0 } : {}}
      transition={{
        duration: 0.6,
        delay: index * 0.08,
        ease: [0.215, 0.61, 0.355, 1]
      }}
      className="group relative"
    >
      {/* Glow effect on hover */}
      <div
        className="absolute -inset-4 rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-2xl"
        style={{ background: sector.bgGlow }}
      />

      <button
        type="button"
        onClick={onClick}
        className={cn(
          'relative w-full text-left p-6 bg-neutral-900/80 backdrop-blur-sm rounded-2xl transition-all duration-500 h-full min-h-[200px] flex flex-col cursor-pointer',
          active ? 'border-2 border-[#cd2653] shadow-[0_0_30px_rgba(205,38,83,0.35)]' : 'border border-white/5 hover:border-white/10'
        )}
      >
        {/* Count badge — real count once loaded, falls back to estimate before */}
        <div className="absolute top-4 right-4">
          <span className="text-xs font-bold text-neutral-500">
            {liveCount === null ? sector.count : liveCount === 0 ? 'New' : `${liveCount}`}
          </span>
        </div>

        {/* Icon */}
        <motion.div
          whileHover={{ scale: 1.1, rotate: 5 }}
          transition={{ type: 'spring', stiffness: 400, damping: 17 }}
          className={cn(
            'w-14 h-14 rounded-2xl flex items-center justify-center mb-5',
            'bg-gradient-to-br shadow-lg',
            sector.color
          )}
          style={{
            boxShadow: `0 10px 40px ${sector.bgGlow}`
          }}
        >
          <sector.icon className="w-7 h-7 text-white" />
        </motion.div>

        {/* Content */}
        <h3 className="text-lg font-bold text-white mb-2 group-hover:text-neutral-50 transition-colors">
          {sector.title}
        </h3>
        <p className="text-sm text-neutral-500 group-hover:text-neutral-400 transition-colors leading-relaxed">
          {sector.description}
        </p>

        {/* Hover indicator */}
        <motion.div
          className="absolute bottom-0 left-0 right-0 h-1 rounded-b-2xl"
          style={{
            background: `linear-gradient(to right, ${sector.bgGlow}, transparent)`
          }}
          initial={{ scaleX: 0, originX: 0 }}
          animate={active ? { scaleX: 1 } : { scaleX: 0 }}
          transition={{ duration: 0.3 }}
        />
      </button>
    </motion.div>
  )
}

function VendorDrawerPanel({ sector, onClose }: { sector: Sector; onClose: () => void }) {
  const [vendors, setVendors] = useState<VendorLite[] | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [vendorBio, setVendorBio] = useState<VendorFull | null>(null)
  const [loadingBio, setLoadingBio] = useState(false)
  const [bioError, setBioError] = useState<string | null>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  // Auto-scroll the panel into view the moment it opens, so users don't have
  // to hunt for the expanded section.
  useEffect(() => {
    const t = setTimeout(() => {
      drawerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
    return () => clearTimeout(t)
  }, [])

  // Fetch vendor list when the drawer opens / sector changes.
  useEffect(() => {
    let cancelled = false
    setLoadingList(true)
    setVendors(null)
    setSelected(null)
    setVendorBio(null)
    fetch(`/api/sectors/${sector.slug}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setVendors((d?.vendors as VendorLite[]) || [])
      })
      .catch(() => { if (!cancelled) setVendors([]) })
      .finally(() => { if (!cancelled) setLoadingList(false) })
    return () => { cancelled = true }
  }, [sector.slug])

  // Fetch bio when a vendor is picked.
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setLoadingBio(true)
    setBioError(null)
    setVendorBio(null)
    fetch(`/api/sectors/${sector.slug}/${selected}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        if (cancelled) return
        if (!d?.vendor) {
          setBioError('That vendor has not finished their profile yet.')
        } else {
          setVendorBio(d.vendor as VendorFull)
        }
      })
      .catch(() => { if (!cancelled) setBioError("Couldn't load this vendor's profile.") })
      .finally(() => { if (!cancelled) setLoadingBio(false) })
    return () => { cancelled = true }
  }, [selected, sector.slug])

  // When a bio loads, scroll it into view so the user sees it.
  useEffect(() => {
    if (vendorBio && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [vendorBio])

  return (
    <motion.div
      ref={drawerRef}
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="scroll-mt-24"
    >
      <div className="mt-8 rounded-3xl border border-white/10 bg-gradient-to-br from-neutral-900/95 to-neutral-950/95 backdrop-blur-sm p-6 md:p-8">
        <div className="flex items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={cn('w-10 h-10 rounded-xl flex items-center justify-center bg-gradient-to-br shrink-0', sector.color)}
              style={{ boxShadow: `0 8px 24px ${sector.bgGlow}` }}
            >
              <sector.icon className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              {selected ? (
                <>
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#cd2653]">{sector.title}</p>
                  <h3 className="text-xl md:text-2xl font-bold text-white truncate">
                    {vendorBio?.business_name || 'Loading…'}
                  </h3>
                </>
              ) : (
                <>
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#cd2653]">Vendors in</p>
                  <h3 className="text-xl md:text-2xl font-bold text-white truncate">{sector.title}</h3>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              // X means "go back one step": from profile -> vendor list, from list -> close drawer.
              if (selected) {
                setSelected(null)
                setVendorBio(null)
              } else {
                onClose()
              }
            }}
            className="flex items-center gap-1.5 text-neutral-400 hover:text-white text-sm transition-colors"
            aria-label={selected ? 'Back to vendor list' : 'Close vendor panel'}
          >
            <X className="w-4 h-4" /> {selected ? 'Back' : 'Close'}
          </button>
        </div>

        {/* Vendor list */}
        <AnimatePresence mode="wait">
          {!selected && (
            <motion.div
              key="list"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {loadingList ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-[#cd2653]" />
                </div>
              ) : !vendors || vendors.length === 0 ? (
                <div className="text-center py-12 text-neutral-400">
                  <p className="text-base">No vendors listed in {sector.title} yet.</p>
                  <Link href="/apply" className="inline-block mt-4 text-[#cd2653] hover:underline text-sm font-medium">
                    Be the first to exhibit →
                  </Link>
                </div>
              ) : (
                <>
                  {/* Fixed-height drawer ≈ 2 rows of sector cards so the expanded panel matches the Sectors grid visually.
                      9 vendor cards visible at once in a 3-row × 3-col layout. Sideways scroll for the next 9. */}
                  <div className="h-[440px] overflow-x-auto overflow-y-hidden snap-x snap-mandatory sectors-h-scroll">
                    <div
                      className="grid grid-flow-col grid-rows-3 gap-4 h-full"
                      style={{ gridAutoColumns: 'calc((100% - 2rem) / 3)' }}
                    >
                      {vendors.map((v) => {
                        const profSlug = slugifyName(v.business_name)
                        return (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => setSelected(profSlug)}
                            className="relative snap-start text-left p-4 rounded-2xl bg-neutral-900/80 backdrop-blur-sm border border-white/5 hover:border-[#cd2653]/40 transition-all duration-300 flex flex-col gap-3 group h-full"
                          >
                            {/* Logo and name sit side by side: the logo alone
                                doesn't identify a vendor, so the name always
                                rides with it. zanii-codef: `truncate` not
                                `line-clamp-*` here, a line-clamped element that
                                is a direct flex child gets blockified to
                                flow-root and collapses to height 0. */}
                            <div className="flex items-center gap-3 min-w-0">
                              {v.logo_url ? (
                                // Vendor's own logo on a white tile (logos are
                                // public brand assets). Falls back to the sector
                                // icon when no logo has been uploaded yet.
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={v.logo_url}
                                  alt={`${v.business_name.trim()} logo`}
                                  // zanii-codef: NOT loading="lazy". These sit in an
                                  // overflow-x:auto track, where Chrome's lazy heuristic
                                  // never fires and the logos silently never load. The
                                  // panel only mounts on click, so nothing loads up front
                                  // anyway, that was the real saving.
                                  decoding="async"
                                  className="w-12 h-12 rounded-xl object-contain bg-white p-1.5 shadow-lg shrink-0"
                                  style={{ boxShadow: `0 8px 30px ${sector.bgGlow}` }}
                                />
                              ) : (
                                <div
                                  className={cn('w-12 h-12 rounded-xl flex items-center justify-center bg-gradient-to-br shadow-lg shrink-0', sector.color)}
                                  style={{ boxShadow: `0 8px 30px ${sector.bgGlow}` }}
                                >
                                  <sector.icon className="w-5 h-5 text-white" />
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <h4 className="text-sm font-bold text-white group-hover:text-neutral-50 transition-colors truncate">
                                  {v.business_name.trim()}
                                </h4>
                                <p className={cn(
                                  'text-[11px] leading-snug truncate transition-colors',
                                  v.business_description ? 'text-neutral-500 group-hover:text-neutral-400' : 'text-neutral-600 italic'
                                )}>
                                  {v.business_description?.replace(/\s+/g, ' ').trim() || 'Profile coming soon'}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 mt-auto text-[11px] text-neutral-500">
                              <span className="text-[#cd2653] font-medium group-hover:text-[#ff7a9c] transition-colors">View →</span>
                              {v.website && <span className="flex items-center gap-1"><Globe className="w-3 h-3" /> Web</span>}
                              {v.instagram && <span className="flex items-center gap-1"><Instagram className="w-3 h-3" /> IG</span>}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  {vendors.length > 9 && (
                    <p className="mt-4 text-center text-xs text-neutral-500">
                      Showing 9 of {vendors.length}. Scroll sideways inside the panel for the rest.
                    </p>
                  )}
                </>
              )}
            </motion.div>
          )}

          {selected && (
            <motion.div
              key="bio"
              ref={detailRef}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="h-[440px] overflow-y-auto pr-2 -mr-2 sectors-v-scroll"
            >
              {loadingBio && (
                <div className="flex justify-center items-center h-full">
                  <Loader2 className="w-6 h-6 animate-spin text-[#cd2653]" />
                </div>
              )}

              {bioError && !loadingBio && (
                <div className="flex items-center justify-center h-full text-neutral-400">
                  <p>{bioError}</p>
                </div>
              )}

              {vendorBio && !loadingBio && (
                <div className="space-y-6">
                  <div className="flex flex-col md:flex-row items-start gap-6">
                    {vendorBio.logo_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={vendorBio.logo_url}
                        alt={`${vendorBio.business_name} logo`}
                        className="w-24 h-24 md:w-28 md:h-28 rounded-2xl object-contain bg-white p-2 shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        {vendorBio.stall_code && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-full px-2.5 py-1">
                            <MapPin className="w-3 h-3" /> Stall {vendorBio.stall_code}
                          </span>
                        )}
                      </div>
                      <h3 className="text-2xl md:text-3xl font-bold text-white mb-1" style={{ fontFamily: '"Fraunces", Georgia, serif' }}>
                        {vendorBio.business_name}
                      </h3>
                      {vendorBio.tagline && (
                        <p className="text-base text-neutral-400">{vendorBio.tagline}</p>
                      )}
                      <div className="flex flex-wrap gap-3 mt-3">
                        {vendorBio.website && (
                          <a href={vendorBio.website} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-sm text-[#cd2653] hover:text-[#ff7a9c] transition-colors">
                            <Globe className="w-3.5 h-3.5" /> Website
                          </a>
                        )}
                        {vendorBio.instagram && (
                          <a href={`https://instagram.com/${vendorBio.instagram.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-sm text-[#cd2653] hover:text-[#ff7a9c] transition-colors">
                            <Instagram className="w-3.5 h-3.5" /> {vendorBio.instagram}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">About</h4>
                    <p className="text-base text-neutral-200 leading-relaxed whitespace-pre-wrap">
                      {vendorBio.write_up}
                    </p>
                  </div>

                  {vendorBio.menu && vendorBio.menu.length > 0 && (
                    <div>
                      <h4 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">
                        {sector.title === 'Food & Beverage' ? 'On the Menu' : 'What They Bring'}
                      </h4>
                      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {vendorBio.menu.map((item, i) => (
                          <li key={i} className="bg-white/[0.03] border border-white/5 rounded-lg px-4 py-3">
                            <div className="flex items-baseline justify-between gap-3">
                              <span className="text-sm font-medium text-white">{item.name}</span>
                              {item.price && <span className="text-xs text-neutral-400 whitespace-nowrap">{item.price}</span>}
                            </div>
                            {item.desc && <p className="text-xs text-neutral-500 mt-1">{item.desc}</p>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="pt-2 border-t border-white/5 flex items-center justify-between">
                    <Link
                      href={`/sectors/${sector.slug}/${vendorBio.slug}`}
                      className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                    >
                      Open full page →
                    </Link>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

export function SectorsSection() {
  const containerRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(containerRef, { once: true, margin: '-100px' })
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const [totalLive, setTotalLive] = useState<number | null>(null)
  const [activeSlug, setActiveSlug] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/sectors/counts')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        if (data && typeof data === 'object' && data.counts) {
          setCounts(data.counts as Record<string, number>)
          setTotalLive(typeof data.total === 'number' ? data.total : null)
        }
      })
      .catch(() => { /* silent — fall back to estimate */ })
    return () => { cancelled = true }
  }, [])

  const activeSector = sectors.find((s) => s.slug === activeSlug) || null

  return (
    <section id="sectors" className="py-24 relative overflow-hidden">
      {/* Background elements */}
      <div className="absolute inset-0 bg-gradient-to-b from-neutral-950 via-neutral-900/50 to-neutral-950" />

      {/* Animated orbs */}
      <motion.div
        className="absolute -top-40 -right-40 w-80 h-80 rounded-full blur-3xl opacity-20"
        style={{ background: 'linear-gradient(135deg, #cd2653, #f59e0b)' }}
        animate={{
          scale: [1, 1.2, 1],
          opacity: [0.1, 0.2, 0.1]
        }}
        transition={{
          duration: 8,
          repeat: Infinity,
          ease: 'easeInOut'
        }}
      />
      <motion.div
        className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full blur-3xl opacity-10"
        style={{ background: 'linear-gradient(135deg, #8b5cf6, #3b82f6)' }}
        animate={{
          scale: [1.2, 1, 1.2],
          opacity: [0.1, 0.15, 0.1]
        }}
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: 'easeInOut'
        }}
      />

      <div ref={containerRef} className="container mx-auto px-4 relative z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
          className="text-center mb-16"
        >
          <motion.span
            initial={{ opacity: 0, scale: 0.9 }}
            animate={isInView ? { opacity: 1, scale: 1 } : {}}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="inline-block px-4 py-1.5 bg-[#cd2653]/10 border border-[#cd2653]/20 rounded-full text-[#cd2653] text-sm font-medium mb-6"
          >
            8 Industry Sectors
          </motion.span>
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6">
            Every Corner of{' '}
            <span className="bg-gradient-to-r from-[#cd2653] to-[#f59e0b] bg-clip-text text-transparent">
              Lifestyle
            </span>
          </h2>
          <p className="text-neutral-400 text-lg max-w-2xl mx-auto">
            From food and fashion to finance and travel, discover exhibitors across all aspects of the lifestyle.
            Tap a sector to see who&rsquo;s exhibiting.
          </p>
        </motion.div>

        {/* Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {sectors.map((sector, i) => (
            <SectorCard
              key={sector.title}
              sector={sector}
              index={i}
              liveCount={counts ? counts[sector.slug] ?? 0 : null}
              active={activeSlug === sector.slug}
              onClick={() => setActiveSlug((cur) => (cur === sector.slug ? null : sector.slug))}
            />
          ))}
        </div>

        {/* Inline expanding vendor panel */}
        <AnimatePresence>
          {activeSector && (
            <VendorDrawerPanel
              key={activeSector.slug}
              sector={activeSector}
              onClose={() => setActiveSlug(null)}
            />
          )}
        </AnimatePresence>

        {/* Total count */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.8 }}
          className="text-center mt-12"
        >
          <p className="text-neutral-500">
            {/* While approvals are still rolling in we keep the aspirational "400+" line.
                Once Samreen flips NEXT_PUBLIC_SECTORS_SHOW_LIVE_TOTAL=1, the real count shows. */}
            <span className="text-2xl font-bold text-white">
              {totalLive !== null && process.env.NEXT_PUBLIC_SECTORS_SHOW_LIVE_TOTAL === '1' ? totalLive : '400+'}
            </span>{' '}
            exhibitors {totalLive !== null && process.env.NEXT_PUBLIC_SECTORS_SHOW_LIVE_TOTAL === '1' ? 'confirmed' : 'expected'} across all sectors
          </p>
        </motion.div>
      </div>
    </section>
  )
}
