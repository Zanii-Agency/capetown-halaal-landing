'use client'

import { useRef } from 'react'
import Image from 'next/image'
import { motion, useScroll, useTransform } from 'framer-motion'
import { ArrowRight, Calendar, MapPin, Users, Play, ChevronDown } from 'lucide-react'
import { GradientText } from '@/components/ui/animated-text'
import { SpotlightCard } from '@/components/ui/spotlight'

export function HeroSection() {
  const containerRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end start']
  })

  const opacity = useTransform(scrollYProgress, [0, 0.5], [1, 0])
  const leftX = useTransform(scrollYProgress, [0, 0.5], [0, -60])
  const rightX = useTransform(scrollYProgress, [0, 0.5], [0, 60])

  return (
    <section ref={containerRef} className="relative min-h-screen overflow-hidden bg-white">
      {/* Left photo — feathers into white center */}
      <motion.div
        className="absolute inset-y-0 left-0 w-[45%] hidden md:block"
        style={{ x: leftX }}
      >
        <Image
          src="/about/festival-crowd.jpg"
          alt="Festival crowd"
          fill
          className="object-cover"
          priority
          sizes="45vw"
        />
        {/* Feathered edge: fades right into white */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-white" style={{
          background: 'linear-gradient(to right, transparent 0%, transparent 40%, rgba(255,255,255,0.4) 60%, rgba(255,255,255,0.85) 80%, white 100%)',
        }} />
        {/* Slight top/bottom fade */}
        <div className="absolute inset-0 bg-gradient-to-b from-white/30 via-transparent to-white/30" />
      </motion.div>

      {/* Right photo — feathers into white center */}
      <motion.div
        className="absolute inset-y-0 right-0 w-[45%] hidden md:block"
        style={{ x: rightX }}
      >
        <Image
          src="/gallery/gallery-3389.jpg"
          alt="Festival vendors"
          fill
          className="object-cover"
          priority
          sizes="45vw"
        />
        {/* Feathered edge: fades left into white */}
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to left, transparent 0%, transparent 40%, rgba(255,255,255,0.4) 60%, rgba(255,255,255,0.85) 80%, white 100%)',
        }} />
        {/* Slight top/bottom fade */}
        <div className="absolute inset-0 bg-gradient-to-b from-white/30 via-transparent to-white/30" />
      </motion.div>

      {/* Mobile: subtle background photo with heavy overlay */}
      <div className="absolute inset-0 md:hidden">
        <Image
          src="/about/festival-crowd.jpg"
          alt="Festival"
          fill
          className="object-cover"
          priority
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-white/80" />
      </div>

      {/* Center content */}
      <motion.div
        className="relative z-10 container mx-auto px-4 pt-24 md:pt-32 pb-16 md:pb-20 min-h-screen flex flex-col justify-center"
        style={{ opacity }}
      >
        <div className="max-w-3xl mx-auto w-full">
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="flex justify-center mb-6 md:mb-8"
          >
            {/* A live-status pill, not a decoration. The sparkle that used to
                lead this badge is the icon every AI tool ships with, so it read
                as "generated" rather than "on sale" (Taona, 2026-07-28). The
                pulsing dot already carries "now", so it leads; the arrow is the
                click affordance the badge never had despite being a link. */}
            <a
              href="https://tickets.youngatheart.co.za"
              target="_blank"
              rel="noopener noreferrer"
              className="group"
            >
              <SpotlightCard className="inline-flex items-center gap-2.5 px-5 py-2.5 bg-neutral-900 backdrop-blur-xl border border-neutral-800 rounded-full hover:bg-neutral-800 transition-colors cursor-pointer">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                <span className="text-sm font-medium text-white">Tickets selling now</span>
                <ArrowRight className="w-4 h-4 text-white/50 transition-transform group-hover:translate-x-0.5" />
              </SpotlightCard>
            </a>
          </motion.div>

          {/* Main heading */}
          <div className="text-center mb-6 md:mb-8 px-2">
            <h1 className="font-bold tracking-tight mb-3 md:mb-4">
              <motion.span
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.2 }}
                className="text-neutral-900 block text-[2rem] sm:text-4xl md:text-6xl lg:text-7xl mb-1 md:mb-2"
              >
                Young at Heart
              </motion.span>
              <span className="block">
                <motion.span
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, delay: 0.5 }}
                  className="text-neutral-900 text-[2rem] sm:text-4xl md:text-6xl lg:text-7xl"
                >
                  Festival{' '}
                </motion.span>
                <motion.span
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 1, duration: 0.6, type: 'spring' }}
                  className="inline-block"
                >
                  <GradientText from="#cd2653" to="#f59e0b" className="text-[2rem] sm:text-4xl md:text-6xl lg:text-7xl font-bold">
                    2026
                  </GradientText>
                </motion.span>
              </span>
            </h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.2, duration: 0.6 }}
              className="text-base sm:text-lg md:text-2xl text-neutral-700 max-w-2xl mx-auto leading-relaxed px-2"
            >
              In association with Smile 90.4 FM.
              <span className="text-neutral-900 font-semibold"> 350+ vendors</span>,
              <span className="text-neutral-900 font-semibold"> 25,000+ visitors</span>,
              <span className="text-neutral-900 font-semibold"> 3 unforgettable days</span>.
            </motion.p>
          </div>

          {/* CTA Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.4, duration: 0.6 }}
            className="flex flex-col sm:flex-row flex-wrap justify-center gap-3 md:gap-4 mb-10 md:mb-16 px-4"
          >
            <a
              href="/apply"
              className="group relative flex items-center justify-center gap-3 px-6 md:px-8 py-3.5 md:py-4 text-base md:text-lg font-semibold text-white overflow-hidden rounded-2xl hover:opacity-90 transition-opacity"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-[#cd2653] to-[#bf3026]" />
              <div className="absolute inset-0 rounded-2xl shadow-[0_0_40px_rgba(205,38,83,0.4)]" />
              <span className="relative z-10 flex items-center gap-3">
                Apply as Exhibitor
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </span>
            </a>

            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => document.getElementById('video')?.scrollIntoView({ behavior: 'smooth' })}
              className="group flex items-center justify-center gap-3 px-6 md:px-8 py-3.5 md:py-4 text-base md:text-lg font-semibold text-neutral-900 bg-white/80 hover:bg-white rounded-2xl border border-neutral-200 backdrop-blur-sm transition-all cursor-pointer"
            >
              <div className="w-9 h-9 md:w-10 md:h-10 rounded-full bg-neutral-200 flex items-center justify-center group-hover:bg-neutral-300 transition-colors">
                <Play className="w-4 h-4 ml-0.5" />
              </div>
              Watch Highlights
            </motion.button>
          </motion.div>

          {/* Stats row */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.6, duration: 0.6 }}
            className="flex flex-col sm:flex-row flex-wrap justify-center gap-3 sm:gap-6 md:gap-8 px-4"
          >
            {[
              { icon: MapPin, label: 'Youngsfield Military Base', color: 'text-red-500' },
              { icon: Calendar, label: 'Dec 11-13, 2026', color: 'text-amber-500' },
              { icon: Users, label: '25,000+ Visitors', color: 'text-blue-500' },
            ].map((item, i) => (
              <motion.div
                key={item.label}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1.8 + i * 0.1 }}
                className="flex items-center justify-center gap-2 text-neutral-700"
              >
                <item.icon className={`w-4 h-4 md:w-5 md:h-5 ${item.color}`} />
                <span className="text-sm md:text-base font-medium">{item.label}</span>
              </motion.div>
            ))}
          </motion.div>
        </div>

        {/* Scroll indicator */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 2.5 }}
          className="absolute bottom-6 md:bottom-8 left-1/2 -translate-x-1/2"
        >
          <motion.div
            animate={{ y: [0, 8, 0] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="flex flex-col items-center gap-2 text-neutral-500"
          >
            <span className="text-xs uppercase tracking-widest">Scroll</span>
            <ChevronDown className="w-5 h-5" />
          </motion.div>
        </motion.div>
      </motion.div>

      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-white to-transparent pointer-events-none z-10" />
    </section>
  )
}
