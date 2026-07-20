'use client'

import Image from 'next/image'
import { motion } from 'framer-motion'
import { Radio } from 'lucide-react'

export function SmileFMBanner() {
  return (
    <a
      href="https://www.smile904.fm"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Smile 90.4 FM, Official Media Partner"
      className="block relative w-full overflow-hidden bg-[#1AA3E8] group"
    >
      {/* Yellow accent strips */}
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-[#F4C518]" />
      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#F4C518]" />

      {/* Subtle radial glow */}
      <div
        className="absolute inset-0 opacity-30 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(255,255,255,0.18) 0%, transparent 60%)',
        }}
      />

      <div className="container mx-auto px-4 py-4 sm:py-5 relative z-10">
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="flex items-center gap-3 text-white"
          >
            <Radio className="w-5 h-5 text-[#F4C518]" />
            <span className="text-xs sm:text-sm font-semibold tracking-[0.2em] uppercase">
              Official Media Partner
            </span>
          </motion.div>

          <div className="hidden sm:block w-px h-8 bg-white/30" />

          <motion.div
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="bg-white rounded-xl px-4 py-2 shadow-lg transition-transform duration-300 group-hover:scale-105"
          >
            <div className="relative h-8 sm:h-10 w-28 sm:w-36">
              <Image
                src="/partners/smile-logo-color.png"
                alt="Smile 90.4 FM"
                fill
                // Container is w-28 sm:w-36 (112-144px). Without `sizes`, a
                // `fill` image defaults to 100vw and Next serves the 1920px
                // variant, costing 110KB for a 144px slot. This was the
                // single heaviest wasted object on the homepage.
                sizes="144px"
                className="object-contain"
                priority
              />
            </div>
          </motion.div>
        </div>
      </div>
    </a>
  )
}
