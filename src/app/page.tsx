'use client'

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { motion, useScroll, useTransform, useInView, AnimatePresence } from 'framer-motion'
import {
  Calendar, MapPin, Users, Building2, ArrowRight, ArrowUpRight,
  Utensils, ShoppingBag, Sparkles, Globe, Award, Clock,
  ChevronRight, Instagram, Facebook, Youtube,
  Mail, Phone, Star, Ticket, Store, Play, ChevronDown, Zap, LogIn
} from 'lucide-react'
import { Logo, LogoMark } from '@/components/logo'
import { HeroSection } from '@/components/hero-section'
import { Spotlight, SpotlightCard } from '@/components/ui/spotlight'
import { TiltCard, ParallaxCard } from '@/components/ui/tilt-card'
import { Marquee, TextMarquee } from '@/components/ui/marquee'
import { AnimatedLetters, GradientText, RevealText } from '@/components/ui/animated-text'
import { SectorsSection } from '@/components/sectors-section'
import { TestimonialsSection } from '@/components/testimonials-section'
import { CountdownSection } from '@/components/countdown-section'
import { VideoSection } from '@/components/video-section'
import { SponsorsSection } from '@/components/sponsors-section'
import { GallerySection } from '@/components/gallery-section'
import { SmileFMBanner } from '@/components/smile-fm-banner'
import { GlowingLine } from '@/components/ui/floating-particles'

// Images
const IMAGES = {
  food1: 'https://images.unsplash.com/photo-1639664342827-2d68822c55c9?w=800&q=80',
  food2: 'https://images.unsplash.com/photo-1694717459401-bf23c6f00980?w=800&q=80',
  food3: 'https://images.unsplash.com/photo-1511690656952-34342bb7c2f2?w=800&q=80',
  food4: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&q=80',
  expo1: 'https://images.unsplash.com/photo-1560439514-4e9645039924?w=800&q=80',
  expo2: 'https://images.unsplash.com/photo-1632383380175-812d44ec112b?w=800&q=80',
  capetown: 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?w=800&q=80',
  bokaap: 'https://images.unsplash.com/photo-1577948000111-9c970dfe3743?w=800&q=80',
  crowd: 'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?w=800&q=80',
  fashion: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=80',
  beauty: 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=800&q=80',
  spices: 'https://images.unsplash.com/photo-1596040033229-a9821ebd058d?w=800&q=80',
}

function AnimatedCounter({ value, suffix = '' }: { value: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-100px' })
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!isInView) return
    const duration = 2000
    const steps = 60
    const increment = value / steps
    let current = 0

    const timer = setInterval(() => {
      current += increment
      if (current >= value) {
        setCount(value)
        clearInterval(timer)
      } else {
        setCount(Math.floor(current))
      }
    }, duration / steps)

    return () => clearInterval(timer)
  }, [isInView, value])

  return (
    <span ref={ref}>
      {count.toLocaleString()}{suffix}
    </span>
  )
}

function SectionHeading({ badge, title, description }: { badge: string; title: string; description: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-100px' })

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.8, ease: [0.215, 0.61, 0.355, 1] }}
      className="text-center mb-16"
    >
      <span className="inline-block px-4 py-1.5 bg-[#cd2653]/10 border border-[#cd2653]/20 rounded-full text-[#cd2653] text-sm font-medium mb-6">
        {badge}
      </span>
      <h2 className="text-2xl sm:text-3xl md:text-5xl lg:text-6xl font-bold text-neutral-900 mb-4 md:mb-6">{title}</h2>
      <p className="text-neutral-600 text-sm md:text-lg max-w-2xl mx-auto px-2">{description}</p>
    </motion.div>
  )
}

function GalleryCard({ image, title, delay = 0 }: { image: string; title: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-50px' })

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 60 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.8, delay, ease: [0.215, 0.61, 0.355, 1] }}
    >
      <TiltCard className="group relative overflow-hidden rounded-2xl cursor-pointer">
        <ParallaxCard className="aspect-[4/3]" depth={30}>
          <Image src={image} alt={title} fill sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" className="object-cover transition-transform duration-700 group-hover:scale-110" />
        </ParallaxCard>
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-all duration-500" />
        <div className="absolute bottom-0 left-0 right-0 p-6 translate-y-4 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-500">
          <p className="text-white font-semibold text-lg">{title}</p>
        </div>
      </TiltCard>
    </motion.div>
  )
}

function FeatureCard({ icon: Icon, title, description, delay = 0 }: { icon: React.ComponentType<{ className?: string }>; title: string; description: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-50px' })

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, delay }}
    >
      <SpotlightCard className="group relative p-8 bg-white border border-neutral-200 rounded-2xl hover:border-neutral-300 hover:shadow-lg transition-all duration-500">
        <div className="absolute inset-0 bg-gradient-to-br from-[#cd2653]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl" />

        <div className="relative">
          <motion.div
            whileHover={{ scale: 1.1, rotate: 5 }}
            className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#cd2653] to-[#bf3026] flex items-center justify-center mb-6 shadow-lg shadow-[#cd2653]/20"
          >
            <Icon className="w-7 h-7 text-white" />
          </motion.div>

          <h3 className="text-xl font-bold text-neutral-900 mb-3">{title}</h3>
          <p className="text-neutral-600 leading-relaxed">{description}</p>
        </div>
      </SpotlightCard>
    </motion.div>
  )
}

function LoadingScreen() {
  return (
    <motion.div
      className="fixed inset-0 z-50 bg-neutral-950 flex items-center justify-center overflow-hidden"
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
    >
      <motion.div
        className="absolute w-[500px] h-[500px] rounded-full blur-[120px] opacity-30"
        style={{ background: 'radial-gradient(circle, #cd2653, transparent 70%)' }}
        animate={{ x: [-100, 100, -100], y: [-50, 80, -50], scale: [1, 1.3, 1] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute w-[400px] h-[400px] rounded-full blur-[100px] opacity-20"
        style={{ background: 'radial-gradient(circle, #f59e0b, transparent 70%)' }}
        animate={{ x: [80, -120, 80], y: [60, -40, 60], scale: [1.2, 0.9, 1.2] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="relative z-10 text-center">
        <div className="overflow-hidden mb-8 pb-2">
          <motion.h1
            initial={{ y: 80 }}
            animate={{ y: 0 }}
            transition={{ duration: 0.8, ease: [0.215, 0.61, 0.355, 1] }}
            className="text-4xl md:text-6xl font-bold text-white tracking-tight"
          >
            Young at Heart
          </motion.h1>
        </div>
        <div className="overflow-hidden mb-10">
          <motion.p
            initial={{ y: 40 }}
            animate={{ y: 0 }}
            transition={{ duration: 0.8, delay: 0.2, ease: [0.215, 0.61, 0.355, 1] }}
            className="text-lg text-neutral-500 tracking-[0.3em] uppercase"
          >
            Festival 2026
          </motion.p>
        </div>
        <motion.div
          initial={{ opacity: 0, scaleX: 0.5 }}
          animate={{ opacity: 1, scaleX: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="w-48 h-[2px] bg-white/10 rounded-full overflow-hidden mx-auto"
        >
          <motion.div
            className="h-full rounded-full"
            style={{ background: 'linear-gradient(90deg, #cd2653, #f59e0b, #cd2653)' }}
            initial={{ x: '-100%' }}
            animate={{ x: '100%' }}
            transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
          />
        </motion.div>
      </div>
    </motion.div>
  )
}

export default function HomePage() {
  const [isLoaded, setIsLoaded] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setIsLoaded(true), 1200)
    return () => clearTimeout(timer)
  }, [])

  if (!isLoaded) {
    return <LoadingScreen />
  }

  const navItems = [
    { label: 'About', href: '#about' },
    { label: 'Sectors', href: '#sectors' },
    { label: 'Exhibit', href: '/apply' },
    { label: 'Sponsors', href: '#sponsors' },
    { label: 'Contact', href: '#contact' },
  ]

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <Spotlight />

      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-xl border-b border-neutral-200">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16 md:h-20">
            <Link href="/">
              <Logo size="md" showText={true} />
            </Link>

            {/* Desktop nav */}
            <div className="hidden lg:flex items-center gap-8">
              {navItems.map((item) => (
                item.href.startsWith('#') ? (
                  <a
                    key={item.label}
                    href={item.href}
                    className="text-sm text-neutral-600 hover:text-neutral-900 transition-colors relative group cursor-pointer"
                  >
                    {item.label}
                    <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-[#cd2653] group-hover:w-full transition-all duration-300" />
                  </a>
                ) : (
                  <Link
                    key={item.label}
                    href={item.href}
                    className="text-sm text-neutral-600 hover:text-neutral-900 transition-colors relative group"
                  >
                    {item.label}
                    <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-[#cd2653] group-hover:w-full transition-all duration-300" />
                  </Link>
                )
              ))}
            </div>

            <div className="flex items-center gap-3">
              <a
                href="/exhibitor/login"
                className="hidden sm:flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-neutral-700 hover:text-[#cd2653] border border-neutral-200 hover:border-[#cd2653]/40 rounded-xl transition-colors"
              >
                <LogIn className="w-4 h-4" />
                <span className="hidden md:inline">Exhibitor Portal</span>
                <span className="md:hidden">Portal</span>
              </a>
              <a
                href="/apply"
                className="relative hidden sm:flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-gradient-to-r from-[#cd2653] to-[#bf3026] rounded-xl shadow-lg shadow-[#cd2653]/20 hover:opacity-90 transition-opacity group"
              >
                <span
                  aria-hidden
                  className="absolute inset-0 -m-0.5 rounded-xl bg-gradient-to-r from-[#cd2653] to-[#f59e0b] opacity-40 blur-md animate-pulse pointer-events-none"
                />
                <span className="relative flex items-center gap-2">
                  <Store className="w-4 h-4" />
                  <span className="hidden md:inline">Vendor Application</span>
                  <span className="md:hidden">Apply</span>
                  <ArrowUpRight className="w-4 h-4" />
                </span>
              </a>

              {/* Mobile hamburger */}
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="lg:hidden w-10 h-10 flex flex-col items-center justify-center gap-1.5 rounded-xl hover:bg-neutral-100 transition-colors"
              >
                <motion.span
                  animate={mobileMenuOpen ? { rotate: 45, y: 6 } : { rotate: 0, y: 0 }}
                  className="block w-5 h-0.5 bg-neutral-900"
                />
                <motion.span
                  animate={mobileMenuOpen ? { opacity: 0 } : { opacity: 1 }}
                  className="block w-5 h-0.5 bg-neutral-900"
                />
                <motion.span
                  animate={mobileMenuOpen ? { rotate: -45, y: -6 } : { rotate: 0, y: 0 }}
                  className="block w-5 h-0.5 bg-neutral-900"
                />
              </button>
            </div>
          </div>
        </div>

        {/* Mobile menu */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="lg:hidden overflow-hidden bg-white border-t border-neutral-100"
            >
              <div className="container mx-auto px-4 py-4 space-y-1">
                {navItems.map((item) => (
                  item.href.startsWith('#') ? (
                    <a
                      key={item.label}
                      href={item.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className="block w-full text-left px-4 py-3 text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 rounded-xl transition-colors text-base font-medium"
                    >
                      {item.label}
                    </a>
                  ) : (
                    <Link
                      key={item.label}
                      href={item.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className="block w-full text-left px-4 py-3 text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 rounded-xl transition-colors text-base font-medium"
                    >
                      {item.label}
                    </Link>
                  )
                ))}
                <a
                  href="https://tickets.youngatheart.co.za"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileMenuOpen(false)}
                  className="w-full mt-2 flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-gradient-to-r from-[#cd2653] to-[#bf3026] rounded-xl"
                >
                  <Ticket className="w-4 h-4" />
                  Get Tickets
                </a>
                <a
                  href="/apply"
                  onClick={() => setMobileMenuOpen(false)}
                  className="w-full flex items-center justify-center gap-2 px-5 py-3 text-sm font-medium text-[#cd2653] border border-[#cd2653]/30 hover:bg-[#cd2653]/5 rounded-xl"
                >
                  <Store className="w-4 h-4" />
                  Vendor Application
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      {/* Hero Section */}
      <HeroSection />

      {/* Marquee — Smile FM brand colors (blue text + yellow accents) */}
      <div className="border-y-2 border-[#F4C518] bg-white">
        <TextMarquee
          text="YOUNG AT HEART FESTIVAL 2026 ✦ IN PARTNERSHIP WITH SMILE 90.4 FM"
          textClassName="text-[#1AA3E8]"
          separatorClassName="text-[#F4C518]"
          separator="✦"
        />
      </div>



      {/* About Section */}
      <section id="about" className="py-24 bg-gradient-to-b from-neutral-50 to-white">
        <div className="container mx-auto px-4">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <motion.div
              initial={{ opacity: 0, x: -50 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
            >
              <span className="inline-block px-4 py-1.5 bg-[#cd2653]/10 border border-[#cd2653]/20 rounded-full text-[#cd2653] text-sm font-medium mb-6">
                About the Festival
              </span>
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-neutral-900 mb-6 leading-tight">
                A South African
                <span className="block">
                  <GradientText from="#cd2653" to="#f59e0b">Lifestyle</GradientText>
                </span>
                Exhibition
              </h2>
              <p className="text-neutral-600 text-base md:text-lg leading-relaxed mb-8">
                Young at Heart Festival brings together the finest products, services,
                and experiences under one roof. From authentic cuisine to lifestyle brands, discover
                everything living has to offer.
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                    <Utensils className="w-5 h-5 text-red-500" />
                  </div>
                  <span className="text-neutral-700 font-medium">Quality Certified</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                    <Globe className="w-5 h-5 text-amber-500" />
                  </div>
                  <span className="text-neutral-700 font-medium">International</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                    <Award className="w-5 h-5 text-blue-500" />
                  </div>
                  <span className="text-neutral-700 font-medium">Premium Venue</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center">
                    <Users className="w-5 h-5 text-green-500" />
                  </div>
                  <span className="text-neutral-700 font-medium">Family Friendly</span>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 50 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
              className="relative"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-[#cd2653]/20 to-[#f59e0b]/10 rounded-3xl blur-3xl" />
              <div className="relative grid grid-cols-2 gap-4">
                <TiltCard className="aspect-square rounded-2xl overflow-hidden">
                  <Image src="/about/festival-food.jpg" alt="Festival food" fill sizes="(min-width: 1024px) 25vw, 50vw" className="object-cover" />
                </TiltCard>
                <TiltCard className="aspect-square rounded-2xl overflow-hidden mt-8">
                  <Image src="/about/festival-crowd.jpg" alt="Festival crowd" fill sizes="(min-width: 1024px) 25vw, 50vw" className="object-cover" />
                </TiltCard>
                <TiltCard className="col-span-2 aspect-video rounded-2xl overflow-hidden shadow-xl">
                  <Image src={IMAGES.capetown} alt="Cape Town" fill sizes="(min-width: 1024px) 50vw, 100vw" className="object-cover" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent flex items-end p-6">
                    <div>
                      <p className="text-white font-bold text-xl">Youngsfield Military Base</p>
                      <p className="text-neutral-200">Cape Town, South Africa</p>
                    </div>
                  </div>
                </TiltCard>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Gallery Section */}
      <GallerySection />

      {/* Sectors Section */}
      <SectorsSection />

      {/* Glowing divider */}
      <GlowingLine />

      {/* Features/Why Section */}
      <section className="py-24 relative overflow-hidden">
        {/* Subtle background pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, #cd2653 1px, transparent 0)',
          backgroundSize: '32px 32px',
        }} />
        <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-gradient-to-br from-[#cd2653]/5 to-transparent rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-[400px] h-[400px] bg-gradient-to-tl from-[#f59e0b]/5 to-transparent rounded-full blur-3xl" />
        <div className="container mx-auto px-4">
          <SectionHeading
            badge="Why Attend"
            title="An Unmissable Experience"
            description="Everything you need for an unforgettable lifestyle exhibition"
          />

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureCard
              icon={Utensils}
              title="Authentic Cuisine"
              description="Sample dishes from over 150 food exhibitors representing cuisines from around the world."
              delay={0}
            />
            <FeatureCard
              icon={ShoppingBag}
              title="Exclusive Deals"
              description="Access show-only promotions and discounts from participating brands."
              delay={0.1}
            />
            <FeatureCard
              icon={Users}
              title="Networking"
              description="Connect with industry leaders, entrepreneurs, and like-minded community members."
              delay={0.2}
            />
            <FeatureCard
              icon={Sparkles}
              title="Live Demos"
              description="Watch cooking demonstrations, fashion shows, and interactive workshops."
              delay={0.3}
            />
            <FeatureCard
              icon={Award}
              title="Premium Experience"
              description="World-class venue with excellent facilities, parking, and accessibility."
              delay={0.4}
            />
            <FeatureCard
              icon={Zap}
              title="Innovation Zone"
              description="Discover the latest in tech, fintech, and sustainable products."
              delay={0.5}
            />
          </div>
        </div>
      </section>

      {/* Testimonials Section */}
      <TestimonialsSection />

      {/* Countdown Section */}
      <CountdownSection />

      {/* Video Section */}
      <VideoSection />

      {/* Sponsors Section */}
      <SponsorsSection />

      {/* Smile FM Official Media Partner Banner — closes the sponsors block */}
      <SmileFMBanner />

      {/* CTA Section */}
      <section className="py-16 md:py-24 relative overflow-x-clip">
        <div className="absolute inset-0">
          {/* Full-bleed CTA background — 100vw is correct here, unlike the
              cards above where the implicit 100vw default was the bug. */}
          <Image src={IMAGES.food4} alt="Food" fill sizes="100vw" className="object-cover" />
          <div className="absolute inset-0 bg-gradient-to-r from-neutral-950/95 via-neutral-950/90 to-neutral-950/95" />
        </div>

        <div className="container mx-auto px-4 relative z-10">
          <div className="max-w-3xl mx-auto text-center">
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
            >
              <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold mb-4 md:mb-6 text-white">
                Ready to{' '}
                <GradientText from="#cd2653" to="#f59e0b">Join Us?</GradientText>
              </h2>
              <p className="text-neutral-400 text-base md:text-xl mb-8 md:mb-10 px-2">
                Secure your booth today and be part of South Africa&apos;s biggest lifestyle event.
              </p>

              <div className="flex flex-col sm:flex-row flex-wrap justify-center gap-3 md:gap-4 px-4">
                <a
                  href="/apply"
                  className="group relative flex items-center justify-center gap-3 px-6 md:px-8 py-3.5 md:py-4 text-base md:text-lg font-semibold text-white rounded-2xl bg-gradient-to-r from-[#cd2653] to-[#bf3026] shadow-2xl shadow-[#cd2653]/30 hover:opacity-90 transition-opacity"
                >
                  <Store className="w-5 h-5" />
                  Apply as Exhibitor
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </a>
                <motion.a
                  href="https://tickets.youngatheart.co.za"
                  target="_blank"
                  rel="noopener noreferrer"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="flex items-center justify-center gap-3 px-6 md:px-8 py-3.5 md:py-4 text-base md:text-lg font-semibold text-white bg-white/10 hover:bg-white/20 rounded-2xl border border-white/20 backdrop-blur-sm transition-all cursor-pointer"
                >
                  <Ticket className="w-5 h-5" />
                  Get Tickets
                </motion.a>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer id="contact" className="border-t border-neutral-200 py-16 bg-neutral-50">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12 mb-12">
            <div>
              <Logo size="lg" showText={true} className="mb-6" />
              <p className="text-neutral-600 text-sm mb-6">
                A South African lifestyle exhibition. December 11-13, 2026 at Youngsfield Military Base, Cape Town.
              </p>
              <div className="flex gap-3">
                {[
                  { icon: Instagram, href: 'https://www.instagram.com/youngatheart_capetown/' },
                  { icon: Facebook, href: 'https://www.facebook.com/capetownhalaal/' },
                  { icon: Youtube, href: '#' },
                ].map((social, i) => (
                  <a
                    key={i}
                    href={social.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-10 h-10 rounded-xl bg-neutral-100 hover:bg-[#cd2653]/20 text-neutral-600 hover:text-[#cd2653] flex items-center justify-center transition-all"
                  >
                    <social.icon className="w-5 h-5" />
                  </a>
                ))}
              </div>
            </div>

            <div>
              <h4 className="font-semibold text-neutral-900 mb-6">Quick Links</h4>
              <ul className="space-y-3 text-sm">
                {[
                  { label: 'About', href: '#about' },
                  { label: 'Apply as Vendor', href: '/apply' },
                  { label: 'Buy Tickets', href: 'https://tickets.youngatheart.co.za' },
                  { label: 'Gallery', href: '#gallery' },
                  { label: 'Sponsors', href: '#sponsors' },
                ].map((link) => (
                  <li key={link.label}>
                    {link.href.startsWith('#') ? (
                      <a
                        href={link.href}
                        onClick={(e) => {
                          e.preventDefault()
                          document.querySelector(link.href)?.scrollIntoView({ behavior: 'smooth' })
                        }}
                        className="text-neutral-600 hover:text-neutral-900 transition-colors cursor-pointer"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href} className="text-neutral-600 hover:text-neutral-900 transition-colors">
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="font-semibold text-neutral-900 mb-6">Event Info</h4>
              <ul className="space-y-3 text-sm">
                <li className="flex items-center gap-2 text-neutral-600">
                  <Calendar className="w-4 h-4 text-[#cd2653]" />
                  December 11-13, 2026
                </li>
                <li className="flex items-center gap-2 text-neutral-600">
                  <MapPin className="w-4 h-4 text-[#cd2653]" />
                  Youngsfield Military Base
                </li>
                <li className="flex items-center gap-2 text-neutral-600">
                  <Clock className="w-4 h-4 text-[#cd2653]" />
                  3 Day Event
                </li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold text-neutral-900 mb-6">Contact</h4>
              <ul className="space-y-3 text-sm">
                <li>
                  <a href="mailto:support@youngatheart.co.za" className="flex items-center gap-2 text-neutral-600 hover:text-neutral-900 transition-colors">
                    <Mail className="w-4 h-4" />
                    support@youngatheart.co.za
                  </a>
                </li>
                <li>
                  <a href="tel:+27659435012" className="flex items-center gap-2 text-neutral-600 hover:text-neutral-900 transition-colors">
                    <Phone className="w-4 h-4" />
                    065 943 5012
                  </a>
                </li>
              </ul>
            </div>
          </div>

          <div className="border-t border-neutral-200 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-neutral-500 text-sm">
              © 2026 Young at Heart Festival. All rights reserved.
            </p>
            <a href="https://zanii.agency" target="_blank" rel="noopener noreferrer" className="text-neutral-500 hover:text-neutral-700 text-sm tracking-wide transition-colors">
              Built by <span className="font-semibold">zanii</span><span className="text-[#2563eb]">.</span>
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
