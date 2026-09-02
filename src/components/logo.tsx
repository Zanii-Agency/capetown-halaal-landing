'use client'

import Image from 'next/image'
import { cn } from '@/lib/utils'

interface LogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl'
  showText?: boolean
  className?: string
  light?: boolean
}

const sizes = {
  sm: { icon: 40, text: 'text-sm', subtext: 'text-[8px]' },
  md: { icon: 65, text: 'text-base', subtext: 'text-[10px]' },
  lg: { icon: 64, text: 'text-lg', subtext: 'text-xs' },
  xl: { icon: 80, text: 'text-2xl', subtext: 'text-sm' },
}

export function Logo({ size = 'md', showText = true, className, light = false }: LogoProps) {
  const s = sizes[size]

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {/* logo-mark.png, NOT logo.png.
          logo.png is a 1732x2310 PORTRAIT canvas whose badge occupies only the
          middle third (measured alpha bbox 759x758, 43.8% of width, 32.8% of
          height). This element sets width and height to the SAME number and no
          object-fit, and nothing in globals.css constrains img aspect, so the
          browser stretched that portrait to fill a square: the mark was both
          distorted and, at 65px, carrying about 21px of actual artwork.
          The mark is that badge cropped square at 512, so a square box now
          renders it edge to edge, undistorted.
          translate-y-[11%] is gone with it. It only ever existed to shove the
          off-centre padding back into view, and on a tightly cropped asset it
          would push the logo out of alignment instead.
          /logo.png keeps its own references: vendors download it for print. */}
      <Image
        src="/logo-mark.png"
        alt="Young at Heart"
        width={s.icon}
        height={s.icon}
        className="flex-shrink-0 object-contain"
        priority
      />

      {showText && (
        <div className="leading-tight">
          <p className={cn('font-bold', light ? 'text-white' : 'text-neutral-900', s.text)}>Young at Heart</p>
          <p className={cn(light ? 'text-white/70' : 'text-neutral-500', s.subtext)}>Festival 2026</p>
        </div>
      )}
    </div>
  )
}

export function LogoMark({ size = 'md', className }: { size?: 'sm' | 'md' | 'lg' | 'xl', className?: string }) {
  const s = sizes[size]

  return (
    <Image
      src="/logo-mark.png"
      alt="Young at Heart"
      width={s.icon}
      height={s.icon}
      className={cn('flex-shrink-0 object-contain', className)}
    />
  )
}
