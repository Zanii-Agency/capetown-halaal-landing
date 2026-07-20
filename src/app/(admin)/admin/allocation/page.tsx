'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { AdminPage } from '@/components/admin/AdminPage'
import FloorCommand, { type FloorBooth, type FloorApp, type FloorStatus } from '@/components/floor/FloorCommand'
import type { MapStall } from '@/components/admin/StallMap'
import AllocationFilters, { type StatusFilter, type AppRowLite } from '@/components/admin/allocation/AllocationFilters'
import { appInSector } from '@/components/admin/allocation/sectors'
import { TIER_META, type StallType } from '@/lib/stalls'

interface AppRow extends AppRowLite {
  contact_name: string | null
  phone: string | null
  email: string | null
  tier_label: string
  stalls?: string[]
  booth_count?: number
  stall_status: string | null
  payment_status?: string
  payment_amount?: number
}
interface Avail { total: number; allocated: number; held: number; available: number }
interface StallsResponse {
  stalls: MapStall[]
  availability: Record<StallType, Avail>
  applications: AppRow[]
  grid: { cols: number; rows: number }
  zones: { label: string; col: number; row: number; w: number; h: number }[]
}

// Booth allocation page. Renders the EXACT SAME map component the vendor portal
// (/exhibitor/portal/stand) uses — FloorCommand — so admin sees the clean
// fit-to-view rendering, dashed-available chips, and brand-red palette.
// Persistence still routes through /api/admin/stalls (⟦STALL:..⟧ marker,
// stall-allocation law). FloorCommand's onAllocate yields a business_name;
// we resolve it back to application_id via data.applications.
export default function AllocationPage() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [data, setData] = useState<StallsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  // Filter state — controls the live countdown above the map.
  const [sector, setSector] = useState<string | null>(null)
  const [tier, setTier] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [selectedVendor, setSelectedVendor] = useState<string | null>(null)
  const [vendorSearch, setVendorSearch] = useState('')
  // Left "Unallocated vendors" column can be collapsed for a full-width map.
  const [vendorPanelCollapsed, setVendorPanelCollapsed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/stalls')
      // API is the auth gate now: an unauthenticated admin gets 401 here, so we
      // route to login (mirrors the old client-side getUser() pre-gate).
      if (res.status === 401) { router.push('/admin/login'); return }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      toast.error(`Could not load stalls: ${e instanceof Error ? e.message : 'error'}`)
    } finally { setLoading(false) }
  }, [router])

  useEffect(() => {
    // No client-side auth pre-gate: the /api/admin/stalls call below already
    // enforces auth (401 -> we route to login). Skipping getUser() here removes
    // an auth round-trip from the critical path so the map paints sooner.
    setReady(true)
    load()
  }, [load])

  // Tier filter narrows which stalls render on the map (countdown applies the
  // sector + status filters too).
  const filteredStalls = useMemo<MapStall[]>(() => {
    if (!data) return []
    const zone: StallType | null = tier ? TIER_META[tier]?.suggestZone ?? null : null
    return data.stalls.filter((s) => (zone ? s.type === zone : true))
  }, [data, tier])

  // For countdown, apply sector + status too.
  const countdownStalls = useMemo<MapStall[]>(() => {
    if (!data) return []
    const zone: StallType | null = tier ? TIER_META[tier]?.suggestZone ?? null : null
    return data.stalls.filter((s) => {
      if (zone && s.type !== zone) return false
      if (status !== 'all') {
        const st = s.status || 'available'
        if (st !== status) return false
      }
      if (sector) {
        const occ = s.occupant as { id?: string } | null
        if (!occ?.id) return false
        const app = data.applications.find((a) => a.id === occ.id)
        if (!app || !appInSector(app, sector)) return false
      }
      return true
    })
  }, [data, tier, sector, status])

  // ---- Adapter: MapStall[] + zones -> FloorBooth[] (same shape StandView builds) ----
  const booths = useMemo<FloorBooth[]>(() => {
    if (!data) return []
    const stallBooths: FloorBooth[] = filteredStalls.map((s) => {
      const occ = s.occupant as { id?: string; business_name?: string } | null
      return {
        code: s.code,
        type: s.type as FloorBooth['type'],
        col: s.col,
        row: s.row,
        w: s.w,
        h: s.h,
        zone: data.zones.find(
          (z) => s.col >= z.col && s.col < z.col + z.w && s.row >= z.row && s.row < z.row + z.h,
        )?.label || '',
        status: (s.status === 'held' ? 'reserved' : (s.status || 'available')) as FloorStatus,
        vendor: occ?.business_name || null,
        applicationId: occ?.id || null,
      }
    })
    const zoneBooths: FloorBooth[] = data.zones.map((z) => ({
      code: `Z-${z.label.replace(/\s+/g, '-')}`,
      type: 'facility' as const,
      col: z.col,
      row: z.row,
      w: z.w,
      h: z.h,
      zone: z.label,
      status: 'facility' as FloorStatus,
      vendor: null,
      applicationId: null,
    }))
    return [...stallBooths, ...zoneBooths]
  }, [data, filteredStalls])

  // Approved-vendor pool for FloorCommand's vendor-name input + datalist.
  // Filtered by sector + tier so Samreen's narrowing still drives the picker.
  const floorApps = useMemo<FloorApp[]>(() => {
    if (!data) return []
    return data.applications
      .filter((a) => {
        if (a.app_status !== 'approved' && !a.stall) return false
        if (sector && !appInSector(a, sector)) return false
        if (tier && a.tier !== tier) return false
        return true
      })
      .map((a) => ({
        id: a.id,
        business_name: a.business_name,
        tier_label: a.tier_label,
        stall: a.stall,
        stalls: a.stalls ?? (a.stall ? [a.stall] : []),
      }))
  }, [data, sector, tier])

  // ---- unallocated vendors for left panel ----
  const unallocatedVendors = useMemo(() => {
    if (!data) return []
    return data.applications.filter((a) => {
      if (a.app_status !== 'approved') return false
      // Only vendors who have settled count for allocation. Approved != paid:
      // a vendor is allocatable once payment_status is 'paid' (money received)
      // or 'waived' (comped, legitimately owes nothing). 'none'/'pending'/
      // 'deferred' vendors are approved but unpaid, so they do NOT take a stall.
      const pay = a.payment_status ?? 'none'
      if (pay !== 'paid' && pay !== 'waived') return false
      // Placed = the vendor's booth list is non-empty (multi-booth aware).
      const boothCount = a.booth_count ?? (a.stalls?.length ?? (a.stall ? 1 : 0))
      if (boothCount > 0) return false
      if (vendorSearch.trim()) {
        const q = vendorSearch.toLowerCase()
        if (!a.business_name.toLowerCase().includes(q)) return false
      }
      if (sector && !appInSector(a, sector)) return false
      if (tier && a.tier !== tier) return false
      return true
    })
  }, [data, vendorSearch, sector, tier])

  // ---- Persistence callbacks wired to /api/admin/stalls ----
  const postStall = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch('/api/admin/stalls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    return j
  }, [])

  const handleAllocate = useCallback(async (
    boothCode: string,
    vendorName: string,
    nextStatus: 'allocated' | 'reserved',
  ) => {
    if (!data) return
    const matched = data.applications.find(
      (a) => a.business_name.toLowerCase() === vendorName.toLowerCase(),
    ) || data.applications.find(
      (a) => a.business_name.toLowerCase().includes(vendorName.toLowerCase()),
    )
    if (!matched) {
      throw new Error(`No approved vendor named "${vendorName}". Approve them under Applications first.`)
    }
    await postStall({ stall_code: boothCode, application_id: matched.id, status: nextStatus })
    await load()
  }, [data, postStall, load])

  const handleRelease = useCallback(async (boothCode: string) => {
    await postStall({ stall_code: boothCode, status: 'clear' })
    await load()
  }, [postStall, load])

  const handleToggleBlock = useCallback(async (boothCode: string, nextBlocked: boolean) => {
    await postStall({ stall_code: boothCode, status: nextBlocked ? 'blocked' : 'clear' })
    await load()
  }, [postStall, load])

  if (!ready) {
    return (
      <div className="h-dvh overflow-hidden flex items-center justify-center text-neutral-400 bg-neutral-50">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  return (
    <AdminPage title="Floor plan" caption="BOOTH ALLOCATION">
    <div className="h-dvh overflow-hidden flex flex-col bg-neutral-50">
      <div className="flex-shrink-0 px-6 py-3 border-b border-neutral-200 bg-white flex items-center gap-4">
        {!loading && data && (
          <AllocationFilters
            stalls={countdownStalls}
            applications={data.applications}
            capacity={Object.fromEntries(
              (Object.keys(data.availability) as StallType[]).map((t) => [t, data.availability[t].total])
            ) as Record<StallType, number>}
            sector={sector}
            setSector={setSector}
            tier={tier}
            setTier={setTier}
            status={status}
            setStatus={setStatus}
          />
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        {loading && (
          <div className="w-80 flex-shrink-0 border-r border-neutral-200 bg-white flex flex-col overflow-hidden animate-pulse">
            <div className="p-3 border-b border-neutral-100 space-y-2">
              <div className="h-3 w-32 rounded bg-neutral-100" />
              <div className="h-7 w-full rounded-md bg-neutral-100" />
            </div>
            <div className="p-3 space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="h-3.5 w-40 rounded bg-neutral-100" />
                  <div className="h-2.5 w-24 rounded bg-neutral-100" />
                </div>
              ))}
            </div>
          </div>
        )}
        {!loading && data && vendorPanelCollapsed && (
          // Collapsed rail: a slim vertical bar with a "Show" affordance so the
          // map gets full width. State is component-local (no persistence).
          <div className="flex-shrink-0 border-r border-neutral-200 bg-white flex flex-col items-center py-3">
            <button
              type="button"
              onClick={() => setVendorPanelCollapsed(false)}
              title="Show unallocated vendors"
              aria-label="Show unallocated vendors"
              aria-expanded={false}
              className="w-8 h-8 flex items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-[#cd2653] transition-colors"
            >
              <PanelLeftOpen size={16} />
            </button>
            <span
              className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-400"
              style={{ writingMode: 'vertical-rl' }}
            >
              Unallocated · {unallocatedVendors.length}
            </span>
          </div>
        )}
        {!loading && data && !vendorPanelCollapsed && (
          <div className="w-80 flex-shrink-0 border-r border-neutral-200 bg-white flex flex-col overflow-hidden">
            <div className="p-3 border-b border-neutral-100">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-semibold text-neutral-800 uppercase tracking-wider" title="Approved vendors who have paid (or been waived) and don't yet have a stall. Unpaid vendors are hidden until payment lands.">Unallocated · Paid</h2>
                <button
                  type="button"
                  onClick={() => setVendorPanelCollapsed(true)}
                  title="Hide vendor list"
                  aria-label="Hide vendor list"
                  aria-expanded={true}
                  className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-[#cd2653] transition-colors"
                >
                  <PanelLeftClose size={14} />
                  Hide
                </button>
              </div>
              <input
                type="text"
                value={vendorSearch}
                onChange={e => setVendorSearch(e.target.value)}
                placeholder="Search vendors..."
                className="w-full px-2 py-1.5 text-xs border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#cd2653]"
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {unallocatedVendors.length === 0 ? (
                <div className="p-4 text-xs text-neutral-400">No unallocated vendors found.</div>
              ) : (
                <div className="divide-y divide-neutral-100">
                  {unallocatedVendors.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelectedVendor(v.id === selectedVendor ? null : v.id)}
                      className={`w-full text-left px-3 py-2.5 hover:bg-neutral-50 transition-colors ${
                        selectedVendor === v.id ? 'bg-[#cd2653]/5 border-l-2 border-[#cd2653]' : ''
                      }`}
                    >
                      <div className="text-sm font-medium text-neutral-900 truncate">{v.business_name}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-neutral-500">{v.tier_label}</span>
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-medium">
                          {v.app_status}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 bg-white">
          {loading && (
            <div className="h-full p-4 animate-pulse">
              <div className="h-full rounded-lg bg-neutral-100 border border-neutral-200" />
            </div>
          )}
          {!loading && data && (
            // FloorCommand owns the single stall detail panel (its internal
            // aside: status / Type / Zone / Vendor / Footprint + allocate /
            // reserve / block). We deliberately do NOT also open a page-level
            // RightDrawer here — that produced two overlapping panels whose two
            // close buttons toggled between states instead of dismissing. One
            // panel, one close button.
            <FloorCommand
              mode="admin"
              hideModeSwitch
              booths={booths}
              grid={data.grid}
              applications={floorApps}
              onAllocate={handleAllocate}
              onRelease={handleRelease}
              onToggleBlock={handleToggleBlock}
            />
          )}
        </div>
      </div>
    </div>
    </AdminPage>
  )
}
