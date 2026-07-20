'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, MessageSquare, ArrowRight, MapPin, Upload } from 'lucide-react'
import FloorCommand, { type FloorBooth } from '@/components/floor/FloorCommand'

interface MapStallRaw {
  code: string
  type: 'FT' | 'FS' | 'TS' | 'BS'
  col: number
  row: number
  w: number
  h: number
  status?: 'available' | 'held' | 'allocated'
  occupant?: { business_name?: string } | null
}
interface MapData {
  stalls: MapStallRaw[]
  grid: { cols: number; rows: number }
  zones: { label: string; col: number; row: number; w: number; h: number }[]
  /** The vendor's allocated booth codes (multi-booth). Empty array = unallocated. */
  mine: string[]
  placed: boolean
  you: { code: string; zone: string } | null
  counts: { allocated: number; total: number }
  neighbours?: string[]
}

export default function StandView() {
  const [data, setData] = useState<MapData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/exhibitor/map')
        const j = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(j.error || 'Could not load the floor plan')
        setData(j)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Something went wrong')
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (error) {
    return (
      <div className="bg-[#FFFFFF] border border-[#E5E5E5]/40 rounded-2xl p-6 text-sm text-[#bf3026]">
        {error}
      </div>
    )
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-[#1B1A17]/55 text-sm py-12 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading the floor plan…
      </div>
    )
  }

  if (!data.mine || data.mine.length === 0) {
    return (
      <div className="rounded-2xl border border-[#E5DCC4] bg-white p-8 text-center">
        <div className="max-w-sm mx-auto">
          <MapPin className="w-10 h-10 text-[#cd2653]/30 mx-auto mb-4" />
          <h3 className="font-serif text-lg mb-2">Your stall is being assigned</h3>
          <p className="text-sm text-neutral-500 mb-4">
            The organisers are finalising the floor plan. You will receive a WhatsApp
            notification when your stall is allocated.
          </p>
          <Link href="/exhibitor/portal/documents"
            className="inline-flex items-center gap-2 text-sm text-[#cd2653] font-medium hover:underline">
            <Upload className="w-4 h-4" />
            Complete your documents while you wait
          </Link>
        </div>
      </div>
    )
  }

  const booths: FloorBooth[] = [
    ...data.stalls.map((s) => ({
      code: s.code,
      type: s.type as FloorBooth['type'],
      col: s.col,
      row: s.row,
      w: s.w,
      h: s.h,
      zone: data.zones.find((z) => s.col >= z.col && s.col < z.col + z.w && s.row >= z.row && s.row < z.row + z.h)?.label || '',
      status: (s.status === 'held' ? 'reserved' : (s.status || 'available')) as FloorBooth['status'],
      vendor: s.occupant?.business_name || null,
      applicationId: null,
    })),
    ...data.zones.map((z) => ({
      code: `Z-${z.label.replace(/\s+/g, '-')}`,
      type: 'facility' as const,
      col: z.col,
      row: z.row,
      w: z.w,
      h: z.h,
      zone: z.label,
      status: 'facility' as const,
      vendor: null,
      applicationId: null,
    })),
  ]

  return (
    <div className="space-y-6">
      <FloorCommand hideModeSwitch={true}
        mode="vendor"
        booths={booths}
        grid={data.grid}
        mineCodes={data.mine}
      />

      <a
        href="/exhibitor/portal/support"
        className="flex items-center justify-between gap-3 bg-[#FFFFFF] border border-[#E5E5E5]/40 rounded-2xl p-5 hover:border-[#cd2653]/50 group transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#cd2653]/10 text-[#cd2653] flex items-center justify-center shrink-0">
            <MessageSquare className="w-5 h-5" />
          </div>
          <div>
            <p className="font-semibold text-[#1B1A17]">Want a different spot?</p>
            <p className="text-sm text-[#1B1A17]/55">Message the organisers to request a stall change or raise a placement concern.</p>
          </div>
        </div>
        <ArrowRight className="w-5 h-5 text-[#1B1A17]/30 group-hover:text-[#cd2653] shrink-0" />
      </a>
    </div>
  )
}
