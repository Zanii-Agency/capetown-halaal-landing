'use client'

import { useRef, useState } from 'react'
import { motion, useInView, AnimatePresence } from 'framer-motion'
import Image from 'next/image'
import { Crown, Star, Award, ExternalLink, X, Mail, Phone, Send, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

type SponsorTier = {
  name: string
  price: string
  icon: typeof Crown
  color: string
  glow: string
  featured: boolean
  benefits: string[]
  available: number
  isPartner?: boolean
  partnerLogo?: string
  partnerSubtitle?: string
}

const sponsorTiers: SponsorTier[] = [
  {
    name: 'Smile 90.4 FM',
    price: 'Official Media Partner',
    icon: Crown,
    color: 'from-[#1AA3E8] to-[#0E7BB8]',
    glow: 'rgba(26, 163, 232, 0.35)',
    featured: true,
    benefits: [
      'Platinum-tier placement',
      'Naming placement under festival name',
      '10 digital ads (6 months pre-event + during event)',
      '3 on-site banners',
      '6m × 3m premium booth',
      'VIP access for 10 guests',
      'Main stage brand mentions'
    ],
    available: 0,
    isPartner: true,
    partnerLogo: '/partners/smile-logo-color.png',
    partnerSubtitle: 'Officially partnered with Young at Heart Festival 2026'
  },
  {
    name: 'Gold Sponsor',
    price: 'R250,000',
    icon: Award,
    color: 'from-amber-400 to-yellow-600',
    glow: 'rgba(251, 191, 36, 0.3)',
    featured: false,
    benefits: [
      '8 digital ads (6 months pre-event + during event)',
      '3 on-site banners',
      '6m × 3m booth',
      'VIP access for 6 guests',
      'Logo on event website',
      'Social media feature posts',
      'Event program listing'
    ],
    available: 4
  },
  {
    name: 'Silver Sponsor',
    price: 'R50,000',
    icon: Star,
    color: 'from-gray-400 to-gray-600',
    glow: 'rgba(156, 163, 175, 0.3)',
    featured: false,
    benefits: [
      '1 on-site banner',
      '3m × 3m booth',
      'VIP access for 2 guests',
      'Logo on event website',
      'Social media mention',
      'Event program listing',
      'Networking event access'
    ],
    available: 8
  }
]

function EnquiryModal({
  isOpen,
  onClose,
  sponsorTier
}: {
  isOpen: boolean
  onClose: () => void
  sponsorTier: string
}) {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    company: '',
    phone: '',
    message: ''
  })
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Honeypot: bots fill hidden fields, humans never see them. Field name must
  // match HONEYPOT_FIELD in src/lib/security/abuse-guard.ts.
  const [honeypot, setHoneypot] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    try {
      const res = await fetch('/api/sponsor-enquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          company: formData.company,
          phone: formData.phone,
          message: formData.message,
          tier: sponsorTier,
          company_website_url: honeypot,
        }),
      })

      if (res.ok) {
        toast.success('Enquiry submitted successfully!', {
          description: `We'll contact you about the ${sponsorTier} package within 24 hours.`
        })
        onClose()
        setFormData({ name: '', email: '', company: '', phone: '', message: '' })
        setHoneypot('')
      } else {
        // Surface a real error and KEEP the form data so the user can retry.
        const data = await res.json().catch(() => ({} as { error?: string }))
        toast.error('Could not submit your enquiry', {
          description: data?.error || 'Please try again, or email support@youngatheart.co.za directly.'
        })
      }
    } catch {
      toast.error('Could not submit your enquiry', {
        description: 'Check your connection and try again, or email support@youngatheart.co.za directly.'
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-lg bg-neutral-900 border border-white/10 rounded-2xl p-6 shadow-2xl"
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
            >
              <X className="w-4 h-4 text-white" />
            </button>

            <div className="mb-6">
              <h3 className="text-2xl font-bold text-white mb-2">
                Enquire About {sponsorTier}
              </h3>
              <p className="text-neutral-400 text-sm">
                Fill out the form below and our team will contact you within 24 hours.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Honeypot — hidden from humans, bots fill it. Never remove. */}
              <input
                type="text"
                name="company_website_url"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
                className="absolute -left-[9999px] h-0 w-0 opacity-0"
                aria-hidden="true"
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1">Name</label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-neutral-500 focus:outline-none focus:border-[#cd2653]/50 transition-colors"
                    placeholder="John Doe"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1">Company</label>
                  <input
                    type="text"
                    required
                    value={formData.company}
                    onChange={(e) => setFormData(prev => ({ ...prev, company: e.target.value }))}
                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-neutral-500 focus:outline-none focus:border-[#cd2653]/50 transition-colors"
                    placeholder="Your Company"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1">Email</label>
                  <input
                    type="email"
                    required
                    value={formData.email}
                    onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-neutral-500 focus:outline-none focus:border-[#cd2653]/50 transition-colors"
                    placeholder="you@company.com"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1">Phone</label>
                  <input
                    type="tel"
                    required
                    value={formData.phone}
                    onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-neutral-500 focus:outline-none focus:border-[#cd2653]/50 transition-colors"
                    placeholder="+27 12 345 6789"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1">Message (Optional)</label>
                <textarea
                  rows={3}
                  value={formData.message}
                  onChange={(e) => setFormData(prev => ({ ...prev, message: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-neutral-500 focus:outline-none focus:border-[#cd2653]/50 transition-colors resize-none"
                  placeholder="Any specific requirements or questions..."
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 bg-gradient-to-r from-[#cd2653] to-[#bf3026] rounded-xl font-semibold text-white flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Submit Enquiry
                  </>
                )}
              </button>
            </form>

            <div className="mt-6 pt-4 border-t border-white/10 flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6 text-sm text-neutral-400">
              <a href="mailto:support@youngatheart.co.za" className="flex items-center gap-2 hover:text-white transition-colors">
                <Mail className="w-4 h-4" />
                support@youngatheart.co.za
              </a>
              <a href="tel:+27659435012" className="flex items-center gap-2 hover:text-white transition-colors">
                <Phone className="w-4 h-4" />
                065 943 5012
              </a>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function SponsorCard({ tier, index, onEnquire }: { tier: SponsorTier; index: number; onEnquire: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-50px' })
  const Icon = tier.icon

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{
        duration: 0.7,
        delay: index * 0.15,
        ease: [0.215, 0.61, 0.355, 1]
      }}
      className="group relative"
    >
      {/* Glow effect */}
      <div
        className="absolute -inset-4 rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-2xl"
        style={{ background: tier.glow }}
      />

      {/* Featured border glow */}
      {tier.featured && !tier.isPartner && (
        <div className="absolute -inset-[1px] bg-gradient-to-r from-slate-300 via-white to-slate-300 rounded-3xl opacity-50 blur-sm" />
      )}
      {tier.isPartner && (
        <div className="absolute -inset-[1px] bg-gradient-to-r from-[#1AA3E8] via-[#F4C518] to-[#1AA3E8] rounded-3xl opacity-60 blur-sm" />
      )}

      <div className={cn(
        "relative h-full p-8 bg-neutral-900/80 backdrop-blur-sm border rounded-3xl hover:border-white/20 transition-all duration-500 flex flex-col",
        tier.featured ? "border-white/20" : "border-white/10"
      )}>
        {/* Available badge — hidden for partner card */}
        {!tier.isPartner && (
          <div className="absolute top-4 right-4">
            <span className="text-xs font-medium text-neutral-500 bg-neutral-800 px-2 py-1 rounded-full">
              {tier.available} spots left
            </span>
          </div>
        )}

        {/* Featured label */}
        {tier.featured && !tier.isPartner && (
          <div className="absolute -top-3 left-8">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gradient-to-r from-slate-200 to-white text-neutral-900 text-xs font-bold rounded-full shadow-lg">
              <Sparkles className="w-3 h-3" />
              MOST POPULAR
            </span>
          </div>
        )}
        {tier.isPartner && (
          <div className="absolute -top-3 left-8">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gradient-to-r from-[#1AA3E8] to-[#0E7BB8] text-white text-xs font-bold rounded-full shadow-lg">
              <Sparkles className="w-3 h-3" />
              OFFICIAL MEDIA PARTNER
            </span>
          </div>
        )}

        {/* Icon or Partner Logo */}
        {tier.isPartner && tier.partnerLogo ? (
          <div className="bg-white rounded-2xl p-3 mb-6 w-fit mx-auto shadow-xl">
            <div className="relative h-12 w-32">
              <Image
                src={tier.partnerLogo}
                alt={tier.name}
                fill
                // Container is h-12 w-32 (128px). See smile-fm-banner: `fill`
                // without `sizes` falls back to 100vw / the 1920px variant.
                sizes="128px"
                className="object-contain"
              />
            </div>
          </div>
        ) : (
          <motion.div
            whileHover={{ scale: 1.1, rotate: 5 }}
            className={cn(
              'w-16 h-16 rounded-2xl flex items-center justify-center mb-6',
              'bg-gradient-to-br shadow-xl',
              tier.color
            )}
          >
            <Icon className="w-8 h-8 text-white" />
          </motion.div>
        )}

        {/* Content */}
        <h3 className="text-2xl font-bold text-white mb-2">{tier.name}</h3>
        {tier.isPartner ? (
          <p className="text-base font-semibold text-[#F4C518] mb-2">
            {tier.price}
          </p>
        ) : (
          <p className={cn(
            'text-3xl font-bold mb-6 bg-gradient-to-r bg-clip-text text-transparent',
            tier.color
          )}>
            {tier.price}
          </p>
        )}
        {tier.isPartner && tier.partnerSubtitle && (
          <p className="text-sm text-neutral-400 mb-6">{tier.partnerSubtitle}</p>
        )}

        {/* Benefits */}
        <ul className="space-y-3 flex-1">
          {tier.benefits.map((benefit, i) => (
            <li key={i} className="flex items-start gap-3">
              <Sparkles className={cn(
                'w-4 h-4 mt-1 flex-shrink-0',
                tier.isPartner ? 'text-[#1AA3E8]' : 'text-[#cd2653]'
              )} />
              <span className="text-sm text-neutral-400">{benefit}</span>
            </li>
          ))}
        </ul>

        {/* CTA — link out for partner, enquire for sponsors */}
        {tier.isPartner ? (
          <a
            href="https://www.smile904.fm"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full mt-8 py-3 rounded-xl font-medium text-white text-center transition-all bg-gradient-to-r from-[#1AA3E8] to-[#0E7BB8] shadow-lg shadow-[#1AA3E8]/20 hover:opacity-90 flex items-center justify-center gap-2"
          >
            Visit Smile 90.4 FM
            <ExternalLink className="w-4 h-4" />
          </a>
        ) : (
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onEnquire}
            className={cn(
              "w-full py-3 rounded-xl font-medium text-white transition-all mt-8",
              tier.featured
                ? "bg-gradient-to-r from-[#cd2653] to-[#bf3026] shadow-lg shadow-[#cd2653]/20"
                : "bg-white/5 hover:bg-white/10 border border-white/10"
            )}
          >
            Enquire Now
          </motion.button>
        )}
      </div>
    </motion.div>
  )
}

export function SponsorsSection() {
  const containerRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(containerRef, { once: true, margin: '-100px' })
  const [modalOpen, setModalOpen] = useState(false)
  const [selectedTier, setSelectedTier] = useState('')

  const handleEnquire = (tierName: string) => {
    setSelectedTier(tierName)
    setModalOpen(true)
  }

  return (
    <>
    <EnquiryModal
      isOpen={modalOpen}
      onClose={() => setModalOpen(false)}
      sponsorTier={selectedTier}
    />
    <section id="sponsors" className="py-24 relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-neutral-950 via-neutral-900/30 to-neutral-950" />

      {/* Decorative elements */}
      <div className="absolute top-1/4 right-0 w-96 h-96 rounded-full blur-[120px] opacity-10 bg-gradient-to-br from-amber-500 to-orange-600" />
      <div className="absolute bottom-1/4 left-0 w-80 h-80 rounded-full blur-[100px] opacity-10 bg-gradient-to-br from-slate-400 to-slate-600" />

      <div ref={containerRef} className="container mx-auto px-4 relative z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
          className="text-center mb-16"
        >
          <span className="inline-block px-4 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-full text-amber-400 text-sm font-medium mb-6">
            Limited Opportunities
          </span>
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6">
            Become a{' '}
            <span className="bg-gradient-to-r from-amber-400 to-yellow-600 bg-clip-text text-transparent">
              Sponsor
            </span>
          </h2>
          <p className="text-neutral-400 text-lg max-w-2xl mx-auto">
            Partner with South Africa&apos;s premier lifestyle festival. Amplify your brand through community alignment, social impact, and maximum visibility.
          </p>
        </motion.div>

        {/* Grid - 3 tiers */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {sponsorTiers.map((tier, i) => (
            <SponsorCard key={tier.name} tier={tier} index={i} onEnquire={() => handleEnquire(tier.name)} />
          ))}
        </div>

        {/* Custom sponsorship CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.6 }}
          className="mt-16 text-center"
        >
          <div className="inline-flex flex-col sm:flex-row items-center gap-4 px-8 py-4 bg-neutral-900/80 border border-white/10 rounded-2xl">
            <span className="text-neutral-400">Looking for a custom package?</span>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleEnquire('Custom Package')}
              className="px-6 py-2 bg-gradient-to-r from-[#cd2653] to-[#bf3026] rounded-xl font-medium text-white"
            >
              Contact Us
            </motion.button>
          </div>
        </motion.div>
      </div>
    </section>
    </>
  )
}
