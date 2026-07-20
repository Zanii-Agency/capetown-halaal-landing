'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { ArrowLeft, Building2, Globe, Instagram, Loader2 } from 'lucide-react'

const SECTOR_MAP: Record<string, { title: string; description: string; icon: string }> = {
  'food-beverage': { title: 'Food & Beverage', description: 'Restaurants, catering, food products & ingredients', icon: '🍽️' },
  'fashion-modest-wear': { title: 'Fashion & Modest Wear', description: 'Clothing, accessories, hijabs & modest fashion', icon: '👗' },
  'beauty-wellness': { title: 'Beauty & Wellness', description: 'Cosmetics, skincare & wellness products', icon: '✨' },
  'health-pharmacy': { title: 'Health & Pharmacy', description: 'Supplements, medicine & health products', icon: '💊' },
  'travel-tourism': { title: 'Travel & Tourism', description: 'Travel agencies, destinations & experiences', icon: '✈️' },
  'home-living': { title: 'Home & Living', description: 'Furniture, decor & home essentials', icon: '🏠' },
  'finance-services': { title: 'Finance & Services', description: 'Islamic banking, takaful & financial services', icon: '💼' },
  'business-trade': { title: 'Business & Trade', description: 'B2B services, suppliers & trade opportunities', icon: '🏢' },
}

interface Vendor {
  id: string
  business_name: string
  business_description: string | null
  website: string | null
  instagram: string | null
  logo_url: string | null
  has_profile: boolean
}

function initials(name: string): string {
  return (name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('')
}

export default function SectorPage() {
  const params = useParams()
  const slug = params.slug as string
  const sector = SECTOR_MAP[slug]
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!sector) return
    fetch(`/api/sectors/${slug}`)
      .then(res => res.json())
      .then(data => {
        setVendors(data.vendors || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [slug, sector])

  if (!sector) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-neutral-900 mb-2">Sector not found</h1>
          <Link href="/#sectors" className="text-[#cd2653] hover:underline">Back to sectors</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="bg-white border-b border-neutral-200">
        <div className="container mx-auto px-4 py-4">
          <Link href="/#sectors" className="inline-flex items-center gap-2 text-neutral-600 hover:text-neutral-900 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Back to Sectors
          </Link>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12">
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center mb-12"
          >
            <span className="text-5xl mb-4 block">{sector.icon}</span>
            <h1 className="text-3xl md:text-4xl font-bold text-neutral-900 mb-3">{sector.title}</h1>
            <p className="text-neutral-600 text-lg">{sector.description}</p>
          </motion.div>

          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin text-[#cd2653]" />
            </div>
          ) : vendors.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center py-16"
            >
              <Building2 className="w-12 h-12 text-neutral-300 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-neutral-700 mb-2">No vendors listed yet</h2>
              <p className="text-neutral-500 mb-6">Be the first to exhibit in this sector.</p>
              <Link
                href="/apply"
                className="inline-flex items-center gap-2 px-6 py-3 bg-[#cd2653] text-white font-medium rounded-lg hover:bg-[#b82049] transition-colors"
              >
                Apply as Exhibitor
              </Link>
            </motion.div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {vendors.map((vendor, i) => {
                const profSlug = (vendor.business_name || '')
                  .toLowerCase()
                  .normalize('NFKD')
                  .replace(/[^a-z0-9\s-]/g, '')
                  .trim()
                  .replace(/\s+/g, '-')
                  .replace(/-+/g, '-')
                  .slice(0, 80)
                const card = (
                  <div className="h-full bg-white rounded-xl border border-neutral-200 p-5 hover:shadow-md transition-shadow flex gap-4">
                    {/* Logo (or branded initials fallback when not uploaded yet) */}
                    {vendor.logo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={vendor.logo_url}
                        alt={`${vendor.business_name} logo`}
                        className="w-14 h-14 rounded-lg object-contain bg-neutral-50 border border-neutral-100 flex-shrink-0"
                      />
                    ) : (
                      <div className="w-14 h-14 rounded-lg bg-[#cd2653]/10 text-[#cd2653] font-bold flex items-center justify-center flex-shrink-0">
                        {initials(vendor.business_name)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <h3 className="text-base font-bold text-neutral-900 mb-0.5 truncate">{vendor.business_name}</h3>
                      {vendor.business_description && (
                        <p className="text-neutral-600 text-sm mb-2 line-clamp-2">{vendor.business_description}</p>
                      )}
                      <div className="flex items-center gap-3 text-sm">
                        {vendor.has_profile && (
                          <span className="text-[#cd2653] hover:underline">View profile →</span>
                        )}
                        {vendor.website && (
                          <span className="flex items-center gap-1 text-neutral-500">
                            <Globe className="w-3.5 h-3.5" /> Website
                          </span>
                        )}
                        {vendor.instagram && (
                          <span className="flex items-center gap-1 text-neutral-500">
                            <Instagram className="w-3.5 h-3.5" /> {vendor.instagram}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
                return (
                  <motion.div
                    key={vendor.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04 }}
                  >
                    {/* Only vendors with a complete public profile have a detail
                        page; the rest render as a non-linked card (no dead 404). */}
                    {vendor.has_profile ? (
                      <Link href={`/sectors/${slug}/${profSlug}`} className="block h-full">
                        {card}
                      </Link>
                    ) : (
                      card
                    )}
                  </motion.div>
                )
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
