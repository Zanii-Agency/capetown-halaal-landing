'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, useInView } from 'framer-motion'

const VIDEOS = [
  '/videos/video1.mp4',
  '/videos/video2.mp4',
  '/videos/video3.mp4',
  '/videos/reel3.mp4',
  '/videos/reel4.mp4',
  '/videos/reel5.mp4',
]

const CLIP_DURATION = 3000

function VideoReel() {
  const [currentIndex, setCurrentIndex] = useState(0)
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([])

  const advance = useCallback(() => {
    setCurrentIndex((prev) => {
      const next = (prev + 1) % VIDEOS.length
      const currentVideo = videoRefs.current[prev]
      const nextVideo = videoRefs.current[next]
      if (currentVideo) {
        currentVideo.pause()
        currentVideo.currentTime = 0
      }
      if (nextVideo) {
        // preload="none" means this clip only starts downloading now, when it
        // becomes visible — not all 6 up front. This is the egress fix.
        nextVideo.currentTime = 0
        nextVideo.play().catch(() => {})
      }
      return next
    })
  }, [])

  useEffect(() => {
    const first = videoRefs.current[0]
    if (first) {
      first.currentTime = 0
      first.play().catch(() => {})
    }
    const interval = setInterval(advance, CLIP_DURATION)
    return () => clearInterval(interval)
  }, [advance])

  return (
    <div className="relative aspect-[16/9] rounded-2xl md:rounded-3xl overflow-hidden bg-neutral-900">
      {VIDEOS.map((src, i) => (
        <video
          key={src}
          ref={(el) => { videoRefs.current[i] = el }}
          muted
          playsInline
          // preload="none": the browser downloads a clip only when we play it,
          // instead of eagerly pulling all six on page load (the 1GB+ spike).
          preload="none"
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700"
          style={{ opacity: i === currentIndex ? 1 : 0 }}
        >
          <source src={src} type="video/mp4" />
        </video>
      ))}

      {/* Subtle gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent pointer-events-none" />
    </div>
  )
}

export function VideoSection() {
  const containerRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(containerRef, { once: true, margin: '-100px' })

  return (
    <section id="video" className="py-16 md:py-24 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-neutral-900/50 to-neutral-950" />

      <div ref={containerRef} className="container mx-auto px-4 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
          className="text-center mb-8 md:mb-12"
        >
          <span className="inline-block px-4 py-1.5 bg-[#cd2653]/10 border border-[#cd2653]/20 rounded-full text-[#cd2653] text-sm font-medium mb-4 md:mb-6">
            Watch The Experience
          </span>
          <h2 className="text-2xl sm:text-3xl md:text-5xl lg:text-6xl font-bold text-white mb-3 md:mb-4">
            See It In{' '}
            <span className="bg-gradient-to-r from-[#cd2653] to-[#f59e0b] bg-clip-text text-transparent">
              Action
            </span>
          </h2>
          <p className="text-neutral-400 text-sm md:text-lg max-w-2xl mx-auto px-2">
            Experience the energy, excitement, and opportunities that await you at Young at Heart Festival.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 60 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="max-w-5xl mx-auto"
        >
          {/* Only mount the reel once the section scrolls into view, so visitors
              who never reach it (or bounce/convert first) download zero video. */}
          {isInView && <VideoReel />}
        </motion.div>
      </div>
    </section>
  )
}
