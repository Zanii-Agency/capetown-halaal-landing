'use client'

// 1:1 React port of the floor-command artifact (remixed-6216b5e6.html).
// Same chrome, same stats line, same legend chips, same mode pill, same SVG
// rendering math (CELL=10, GAP=1.2, max-width 1180px), same drawer interaction
// model. The ONLY changes from the original artifact:
//   - Palette swap from dark navy + orange to white + CTH brand-red.
//   - Free-text vendor input is validated against approved applications so the
//     existing /api/admin/stalls POST contract is honoured (Law 8: ⟦STALL⟧
//     marker on vendor_applications.admin_notes, no schema changes).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type FloorStatus = 'available' | 'allocated' | 'reserved' | 'blocked' | 'facility'

export interface FloorBooth {
  code: string
  type: 'FT' | 'FS' | 'TS' | 'BS' | 'facility'
  col: number
  row: number
  w: number
  h: number
  zone?: string
  status: FloorStatus
  vendor: string | null
  applicationId?: string | null
}

export interface FloorApp {
  id: string
  business_name: string
  tier_label?: string
  /** First allocated code (backward-compat). */
  stall?: string | null
  /** Full list of the vendor's allocated codes (multi-booth). */
  stalls?: string[]
}

export interface FloorCommandProps {
  mode: 'admin' | 'vendor'
  booths: FloorBooth[]
  grid: { cols: number; rows: number }
  applications?: FloorApp[]
  /** Single owned booth code (backward-compat, single-booth vendors). */
  mineCode?: string | null
  /** Full list of the vendor's owned booth codes (multi-booth). Every code in
   *  this set is flagged as "yours" on the map. Takes precedence over mineCode. */
  mineCodes?: string[]
  /** Hide the Admin/Vendor toggle pill. The page already knows its role. */
  hideModeSwitch?: boolean
  onAllocate?: (boothCode: string, vendorName: string, status: 'allocated' | 'reserved') => Promise<void> | void
  onRelease?: (boothCode: string) => Promise<void> | void
  onToggleBlock?: (boothCode: string, nextBlocked: boolean) => Promise<void> | void
  onStallClick?: (boothCode: string) => void
}

// ---------------- palette (white + brand-red only) ----------------
const C = {
  ink: '#ffffff',          // page bg (was dark navy in artifact)
  panel: '#ffffff',        // card bg (was darker panel)
  panel2: '#fafafa',       // input bg
  line: '#e5e5e5',         // borders (was dark grid)
  text: '#171717',         // ink
  muted: '#737373',        // neutral-500
  brand: '#cd2653',        // brand-red (replaces orange)
  brand2: '#bf3026',       // brand-dark
  // Status-specific (white-page reads, brand-red is the only chromatic accent)
  availFill: '#ffffff',
  availStroke: '#cd2653',       // available draws attention via dashed brand-red
  allocFill: '#cd2653',
  allocStroke: '#7d1230',
  resvFill: '#fde6ec',          // brand-red 25% tint
  resvStroke: '#cd2653',
  blockFill: '#f5f5f5',
  blockStroke: '#a3a3a3',
  facilityFill: '#f5f5f5',
  facilityStroke: '#a3a3a3',
} as const

const CELL = 10
const GAP = 1.2

function fillFor(status: FloorStatus): string {
  if (status === 'allocated') return C.allocFill
  if (status === 'reserved') return C.resvFill
  if (status === 'blocked') return C.blockFill
  if (status === 'facility') return C.facilityFill
  return C.availFill
}
function strokeFor(status: FloorStatus): string {
  if (status === 'allocated') return C.allocStroke
  if (status === 'reserved') return C.resvStroke
  if (status === 'blocked') return C.blockStroke
  if (status === 'facility') return C.facilityStroke
  return C.availStroke
}
function textFill(status: FloorStatus): string {
  if (status === 'allocated') return '#ffffff'
  if (status === 'reserved' || status === 'available') return C.brand
  return C.muted
}
function tagBg(status: FloorStatus): string {
  if (status === 'allocated') return '#fde6ec'
  if (status === 'reserved') return '#fde6ec'
  if (status === 'available') return '#ecfdf5'
  if (status === 'blocked') return '#f5f5f5'
  return '#f5f5f5'
}
function tagFg(status: FloorStatus): string {
  if (status === 'allocated') return C.brand2
  if (status === 'reserved') return C.brand
  if (status === 'available') return '#047857'
  if (status === 'blocked') return C.muted
  return C.muted
}

export default function FloorCommand({
  mode: initialMode,
  booths,
  grid,
  applications = [],
  mineCode = null,
  mineCodes,
  hideModeSwitch = false,
  onAllocate,
  onRelease,
  onToggleBlock,
  onStallClick,
}: FloorCommandProps) {
  // Owned booth codes (multi-booth aware). `mineCodes` (array) wins; fall back to
  // the legacy single `mineCode`. EVERY code in this set is flagged as "yours".
  const mineSet = useMemo(() => {
    const list = (mineCodes && mineCodes.length ? mineCodes : (mineCode ? [mineCode] : []))
    return new Set(list)
  }, [mineCodes, mineCode])
  // Primary owned code: the anchor used for initial selection. First in the list.
  const primaryMine = (mineCodes && mineCodes.length ? mineCodes[0] : mineCode) || null
  const hasMine = mineSet.size > 0

  const [mode, setMode] = useState<'admin' | 'vendor'>(initialMode)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [vendorInput, setVendorInput] = useState('')
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const toastTimer = useRef<NodeJS.Timeout | null>(null)
  // Refs to the scroll container + each booth <g> so a search can scroll the
  // first matching booth into view.
  const mapScrollRef = useRef<HTMLDivElement | null>(null)
  const boothRefs = useRef<Record<string, SVGGElement | null>>({})

  useEffect(() => {
    setMode(initialMode)
    if (initialMode === 'vendor' && primaryMine) setSelected(primaryMine)
  }, [initialMode, primaryMine])

  const selBooth = useMemo(() => booths.find((b) => b.code === selected) || null, [booths, selected])

  // The application that owns the selected booth (matched by vendor name), so the
  // drawer can show how many booths they hold in total (multi-booth context).
  const selVendorApp = useMemo(() => {
    if (!selBooth?.vendor) return null
    const v = selBooth.vendor.toLowerCase()
    return applications.find((a) => a.business_name.toLowerCase() === v) || null
  }, [selBooth, applications])

  // Crop viewBox to actual booth+facility extent (live stalls.json is 216x167
  // but only ~50% is used). Padding 1 grid cell so outermost stalls don't hug.
  const bbox = useMemo(() => {
    if (booths.length === 0) return { minX: 0, minY: 0, maxX: grid.cols, maxY: grid.rows }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const b of booths) {
      if (b.col < minX) minX = b.col
      if (b.row < minY) minY = b.row
      if (b.col + b.w > maxX) maxX = b.col + b.w
      if (b.row + b.h > maxY) maxY = b.row + b.h
    }
    return {
      minX: Math.max(0, minX - 1),
      minY: Math.max(0, minY - 1),
      maxX: Math.min(grid.cols, maxX + 1),
      maxY: Math.min(grid.rows, maxY + 1),
    }
  }, [booths, grid.cols, grid.rows])

  const viewBox = `${bbox.minX * CELL} ${bbox.minY * CELL} ${(bbox.maxX - bbox.minX) * CELL} ${(bbox.maxY - bbox.minY) * CELL}`

  // Visible area in viewBox units (used to scale text/stroke so they read at any
  // grid size). Artifact's baseline is a 600-unit-wide grid; our text + strokes
  // get multiplied by (viewBoxWidth / 600).
  const vbw = (bbox.maxX - bbox.minX) * CELL
  const vbh = (bbox.maxY - bbox.minY) * CELL
  const scale = Math.max(1, Math.max(vbw, vbh) / 600)
  const stallFontSize = 5.4 * scale
  const stallStrokeW = 0.6 * scale
  const stallSelStrokeW = 1.8 * scale

  const stats = useMemo(() => {
    const c = { available: 0, allocated: 0, reserved: 0, blocked: 0 }
    let total = 0
    booths.forEach((b) => {
      if (b.type === 'facility') return
      total++
      if (b.status in c) c[b.status as keyof typeof c]++
    })
    const committed = total ? Math.round(((c.allocated + c.reserved) / total) * 100) : 0
    return { total, ...c, committed }
  }, [booths])

  const hasActiveSearch = search.trim().length > 0

  // Match booths by code OR by allocated vendor business name (both lowercased).
  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return new Set<string>()
    const hits = new Set<string>()
    booths.forEach((b) => {
      if (b.type === 'facility') return
      if (b.code.toLowerCase().includes(q)) hits.add(b.code)
      if (b.vendor?.toLowerCase().includes(q)) hits.add(b.code)
    })
    return hits
  }, [search, booths])

  useEffect(() => {
    if (mode !== 'vendor') return
    const q = search.trim().toLowerCase()
    if (q.length > 2) {
      const m = booths.find((b) => b.vendor && b.vendor.toLowerCase().includes(q))
      if (m) setSelected(m.code)
    }
  }, [search, mode, booths])

  // Scroll the first matching booth into view so a search on a large floor is
  // actionable, not just a colour change buried off-screen. Runs on every
  // search change (admin + vendor); harmless when there are no hits.
  useEffect(() => {
    if (!hasActiveSearch || searchHits.size === 0) return
    const firstHit = booths.find((b) => searchHits.has(b.code))
    if (!firstHit) return
    const el = boothRefs.current[firstHit.code]
    el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
  }, [hasActiveSearch, searchHits, booths])

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400)
  }, [])

  const handleStallClick = useCallback((b: FloorBooth) => {
    if (b.type === 'facility') return
    setSelected(b.code)
    setVendorInput('')
    onStallClick?.(b.code)
  }, [onStallClick])

  const closeDrawer = useCallback(() => {
    setSelected(null)
    setVendorInput('')
  }, [])

  // Booth count for a vendor (multi-booth aware), used in the drawer + datalist.
  const boothCountOf = useCallback((a: FloorApp) =>
    a.stalls && a.stalls.length ? a.stalls.length : a.stall ? 1 : 0
  , [])

  const matchApplication = useCallback((name: string) => {
    const q = name.trim().toLowerCase()
    if (!q) return null
    const matches = (a: { business_name: string }) =>
      a.business_name.toLowerCase() === q || a.business_name.toLowerCase().includes(q)
    // Multi-booth model: ONE application per vendor holding a LIST of codes.
    // Allocating to a vendor who already has booths ADDS to their list (the API
    // appends), so we just match by name — placed or not. Exact match wins over
    // a substring match.
    return applications.find((a) => a.business_name.toLowerCase() === q)
      || applications.find(matches)
      || null
  }, [applications])

  const doAllocate = useCallback(async (status: 'allocated' | 'reserved') => {
    if (!selBooth) return
    const name = vendorInput.trim()
    if (!name) { showToast('Enter a vendor name first'); return }
    const matched = matchApplication(name)
    if (!matched) {
      showToast(`No approved vendor named "${name}". Approve them under Applications first.`)
      return
    }
    if (!onAllocate) return
    setSaving(true)
    try {
      await onAllocate(selBooth.code, matched.business_name, status)
      showToast(`${selBooth.code} ${status === 'reserved' ? 'reserved for' : 'allocated to'} ${matched.business_name}`)
      closeDrawer()
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [selBooth, vendorInput, matchApplication, onAllocate, showToast, closeDrawer])

  const doRelease = useCallback(async () => {
    if (!selBooth || !onRelease) return
    setSaving(true)
    try {
      await onRelease(selBooth.code)
      showToast(`${selBooth.code} released`)
      closeDrawer()
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Release failed')
    } finally {
      setSaving(false)
    }
  }, [selBooth, onRelease, showToast, closeDrawer])

  const doToggleBlock = useCallback(async () => {
    if (!selBooth || !onToggleBlock) return
    const nextBlocked = selBooth.status !== 'blocked'
    setSaving(true)
    try {
      await onToggleBlock(selBooth.code, nextBlocked)
      showToast(`${selBooth.code} ${nextBlocked ? 'blocked' : 'unblocked'}`)
      closeDrawer()
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [selBooth, onToggleBlock, showToast, closeDrawer])

  // ---------------- render ----------------
  return (
    <div
      style={{
        background: C.ink,
        color: C.text,
        fontFamily: '"Segoe UI",system-ui,-apple-system,sans-serif',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* HEADER */}
      <header
        style={{
          display: 'flex', alignItems: 'center', gap: 16, padding: '12px 20px',
          borderBottom: `1px solid ${C.line}`, background: C.panel, flexWrap: 'wrap',
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: '.5px' }}>
          YOUNG AT HEART <span style={{ color: C.brand }}>FESTIVAL ’26</span>
          <small style={{
            display: 'block', fontWeight: 400, color: C.muted, fontSize: 11,
            letterSpacing: '1.5px', textTransform: 'uppercase',
          }}>
            Floor Command · Youngsfield Base
          </small>
        </div>
        <div style={{ position: 'relative' }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search booth or vendor"
            style={{
              background: C.panel2, border: `1px solid ${C.line}`, color: C.text,
              borderRadius: 8, padding: '9px 12px', fontSize: 13, width: 230, outline: 'none',
            }}
          />
        </div>
        {!hideModeSwitch && (
          <div
            style={{
              marginLeft: 'auto', display: 'flex', background: C.panel2,
              border: `1px solid ${C.line}`, borderRadius: 99, padding: 3,
            }}
          >
            <button
              onClick={() => setMode('admin')}
              style={{
                border: 0, padding: '7px 16px', borderRadius: 99, cursor: 'pointer',
                fontSize: 13, fontWeight: 600,
                background: mode === 'admin' ? C.brand : 'transparent',
                color: mode === 'admin' ? '#fff' : C.muted,
              }}
            >
              Admin
            </button>
            <button
              onClick={() => setMode('vendor')}
              style={{
                border: 0, padding: '7px 16px', borderRadius: 99, cursor: 'pointer',
                fontSize: 13, fontWeight: 600,
                background: mode === 'vendor' ? C.brand : 'transparent',
                color: mode === 'vendor' ? '#fff' : C.muted,
              }}
            >
              Vendor
            </button>
          </div>
        )}
      </header>

      {/* STATS */}
      <div
        style={{
          display: 'flex', gap: 14, padding: '8px 20px 10px', background: C.panel,
          borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap', fontSize: 12, color: C.muted,
        }}
      >
        <span><b style={{ color: C.text, fontSize: 14, marginRight: 3 }}>{stats.total}</b>booths</span>
        <span><b style={{ color: '#047857', fontSize: 14, marginRight: 3 }}>{stats.available}</b>available</span>
        <span><b style={{ color: C.brand, fontSize: 14, marginRight: 3 }}>{stats.allocated}</b>allocated</span>
        <span><b style={{ color: C.brand, fontSize: 14, marginRight: 3 }}>{stats.reserved}</b>reserved</span>
        <span style={{ marginLeft: 'auto' }}><b style={{ color: C.text, fontSize: 14, marginRight: 3 }}>{stats.committed}%</b>committed</span>
      </div>

      {/* LEGEND */}
      <div
        style={{
          display: 'flex', gap: 14, padding: '8px 20px', background: C.panel,
          borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap', fontSize: 12, color: C.muted,
        }}
      >
        <LegendChip fill={C.availFill} stroke={C.availStroke} dashed label="Available" />
        <LegendChip fill={C.allocFill} stroke={C.allocStroke} label="Allocated" />
        <LegendChip fill={C.resvFill} stroke={C.resvStroke} label="Reserved" />
        <LegendChip fill={C.blockFill} stroke={C.blockStroke} dashed label="Blocked" />
        <LegendChip fill={C.facilityFill} stroke={C.facilityStroke} label="Facilities" />
      </div>

      {/* VENDOR HINT */}
      {mode === 'vendor' && (
        <div
          style={{
            padding: '10px 20px', fontSize: 13, color: C.muted,
            background: C.panel, borderBottom: `1px solid ${C.line}`,
          }}
        >
          Vendor mode: search your business name above to find your booth on the map.
        </div>
      )}

      {/* MAIN */}
      <main style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div
          ref={mapScrollRef}
          data-testid="floor-map"
          style={{
            flex: 1, overflow: 'auto', padding: 24,
            background: `radial-gradient(900px 360px at 70% -5%, #fef7f5 0%, transparent 60%), ${C.ink}`,
          }}
        >
          <svg
            viewBox={viewBox}
            style={{ display: 'block', margin: '0 auto', maxWidth: 1180, width: '100%', height: 'auto' }}
            preserveAspectRatio="xMidYMid meet"
            xmlns="http://www.w3.org/2000/svg"
          >
            {booths.map((b) => {
              const isFacility = b.type === 'facility'
              const isSel = selected === b.code
              const isMine = mineSet.has(b.code)
              const isHit = searchHits.has(b.code)
              // Dim non-matches while a search is active (any mode), so the few
              // matches stand out. Facilities never dim — they're context.
              const searchDim = hasActiveSearch && searchHits.size > 0 && !isHit && !isFacility
              const isDimmed = searchDim || (mode === 'vendor' && hasMine && !isMine && !isHit)
              const fill = isMine ? C.brand : fillFor(b.status)
              const stroke = isMine ? C.brand2 : isSel || isHit ? C.brand : strokeFor(b.status)
              const tcolor = isMine ? '#fff' : textFill(b.status)
              const isDashed = b.status === 'available' || b.status === 'blocked'
              const x = b.col * CELL + GAP / 2
              const y = b.row * CELL + GAP / 2
              const w = Math.max(b.w * CELL - GAP, CELL * 1.8 - GAP)
              const h = Math.max(b.h * CELL - GAP, CELL * 1.8 - GAP)
              const cx = b.col * CELL + Math.max(b.w * CELL, CELL * 1.8) / 2
              const cy = b.row * CELL + Math.max(b.h * CELL, CELL * 1.8) / 2 + (1.5 * scale)
              return (
                <g
                  key={b.code}
                  ref={(el) => { boothRefs.current[b.code] = el }}
                  style={{
                    cursor: isFacility ? 'default' : 'pointer',
                    transition: 'filter .12s, opacity .25s',
                    opacity: isDimmed ? 0.25 : 1,
                  }}
                  onClick={() => handleStallClick(b)}
                  onMouseEnter={(e) => !isFacility && (e.currentTarget.style.filter = 'brightness(1.06)')}
                  onMouseLeave={(e) => (e.currentTarget.style.filter = 'none')}
                >
                  <rect
                    x={x}
                    y={y}
                    width={w}
                    height={h}
                    rx={2.5 * scale}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isSel || isMine || isHit ? stallSelStrokeW : stallStrokeW}
                    strokeDasharray={isDashed ? `${2 * scale} ${1.5 * scale}` : undefined}
                    filter={isSel || isMine ? `drop-shadow(0 0 ${4 * scale}px ${C.brand}55)` : undefined}
                  />
                  <text
                    x={cx}
                    y={cy}
                    textAnchor="middle"
                    fontSize={isFacility ? stallFontSize * 0.85 : stallFontSize}
                    fontWeight={700}
                    fill={tcolor}
                    pointerEvents="none"
                    style={{ fontFamily: 'inherit' }}
                  >
                    {isFacility && b.code.startsWith('Z-')
                      ? (b.zone || b.code).split(' ')[0]
                      : b.code}
                  </text>
                  {isMine && (
                    <text
                      x={cx}
                      y={y - (1.5 * scale)}
                      textAnchor="middle"
                      fontSize={2.6 * scale}
                      fontWeight={800}
                      fill={C.brand}
                    >
                      YOU ARE HERE
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>

        {/* DRAWER */}
        {selBooth && (
          <aside
            className="floor-drawer"
            style={{
              width: 330,
              background: C.panel,
              borderLeft: `1px solid ${C.line}`,
              padding: 22,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span
                style={{
                  display: 'inline-block', fontSize: 11, fontWeight: 700,
                  letterSpacing: 1, textTransform: 'uppercase', padding: '4px 10px',
                  borderRadius: 99, background: tagBg(selBooth.status), color: tagFg(selBooth.status),
                }}
              >
                {selBooth.status}
              </span>
              <button
                onClick={closeDrawer}
                style={{
                  marginLeft: 'auto', background: 'none', border: 0, color: C.muted,
                  fontSize: 20, cursor: 'pointer', lineHeight: 1,
                }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <h2 style={{ fontSize: 26, letterSpacing: '.5px', color: C.text, fontWeight: 700 }}>
              {selBooth.code}
            </h2>
            <div>
              <KV label="Type" value={prettyType(selBooth.type)} />
              <KV label="Zone" value={selBooth.zone || '·'} />
              <KV label="Vendor" value={selBooth.vendor || '·'} />
              {selVendorApp && (selVendorApp.stalls?.length || 0) > 1 && (
                <KV
                  label="Booths"
                  value={
                    <span>
                      <b style={{ color: C.brand }}>{selVendorApp.stalls!.length}</b>
                      {' · '}
                      <span style={{ color: C.muted }}>{selVendorApp.stalls!.join(', ')}</span>
                    </span>
                  }
                />
              )}
              <KV
                label="Footprint"
                value={selBooth.type === 'FS' ? '3 × 3 m' : selBooth.type === 'TS' ? '2 × 2 m' : selBooth.type === 'FT' ? 'Truck bay' : '3 × 3 m'}
              />
            </div>

            {/* ADMIN: actions */}
            {mode === 'admin' && (
              <>
                {(selBooth.status === 'available' || selBooth.status === 'blocked') && (
                  <>
                    <input
                      value={vendorInput}
                      onChange={(e) => setVendorInput(e.target.value)}
                      placeholder="Vendor / business name"
                      list="floor-approved-list"
                      style={{
                        width: '100%', background: C.panel2, border: `1px solid ${C.line}`,
                        color: C.text, borderRadius: 8, padding: 10, fontSize: 13, outline: 'none',
                      }}
                    />
                    <datalist id="floor-approved-list">
                      {/* All approved vendors, placed or not. A placed vendor's
                          option is annotated with their current booth count so
                          picking them clearly ADDS a booth (multi-booth). */}
                      {applications.map((a) => {
                        const n = boothCountOf(a)
                        const tier = a.tier_label || ''
                        const placed = n > 0 ? `${n} booth${n > 1 ? 's' : ''}` : ''
                        const label = [tier, placed].filter(Boolean).join(' · ')
                        return <option key={a.id} value={a.business_name} label={label} />
                      })}
                    </datalist>
                    {(() => {
                      // If the typed vendor already holds booths, this allocation
                      // ADDS a booth to them (multi-booth) rather than being their
                      // first. Surface that so it never reads as a mistake.
                      const typed = matchApplication(vendorInput)
                      const n = typed ? boothCountOf(typed) : 0
                      if (!typed || n === 0) return null
                      return (
                        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                          {typed.business_name} already holds <b style={{ color: C.brand }}>{n} booth{n > 1 ? 's' : ''}</b>
                          {typed.stalls && typed.stalls.length ? ` (${typed.stalls.join(', ')})` : ''}. This adds {selBooth.code}.
                        </div>
                      )
                    })()}
                    <BtnP onClick={() => doAllocate('allocated')} disabled={saving}>
                      {(() => {
                        const typed = matchApplication(vendorInput)
                        return typed && boothCountOf(typed) > 0 ? 'Add this booth' : 'Allocate booth'
                      })()}
                    </BtnP>
                    <BtnG onClick={() => doAllocate('reserved')} disabled={saving}>Hold as reserved</BtnG>
                    {selBooth.status === 'blocked'
                      ? <BtnG onClick={doToggleBlock} disabled={saving}>Unblock</BtnG>
                      : <BtnD onClick={doToggleBlock} disabled={saving}>Block booth</BtnD>}
                  </>
                )}
                {(selBooth.status === 'allocated' || selBooth.status === 'reserved') && (
                  <>
                    {selBooth.status === 'reserved' && (
                      <input
                        value={vendorInput}
                        onChange={(e) => setVendorInput(e.target.value)}
                        placeholder={`Confirm allocation to ${selBooth.vendor || 'this vendor'}`}
                        style={{
                          width: '100%', background: C.panel2, border: `1px solid ${C.line}`,
                          color: C.text, borderRadius: 8, padding: 10, fontSize: 13, outline: 'none',
                        }}
                      />
                    )}
                    <BtnP
                      onClick={() => doAllocate('allocated')}
                      disabled={saving || selBooth.status === 'allocated' || !vendorInput.trim()}
                    >
                      Confirm allocation
                    </BtnP>
                    <BtnD onClick={doRelease} disabled={saving}>Release booth</BtnD>
                  </>
                )}
              </>
            )}

            {mode === 'vendor' && mineSet.has(selBooth.code) && (
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55 }}>
                This is your booth. If anything looks off, message the organisers from the support page.
              </div>
            )}
          </aside>
        )}
      </main>

      {/* TOAST */}
      <div
        style={{
          position: 'fixed', bottom: 24, left: '50%',
          transform: toastMsg
            ? 'translateX(-50%) translateY(0)'
            : 'translateX(-50%) translateY(90px)',
          background: C.brand, color: '#fff', padding: '11px 22px', borderRadius: 99,
          fontSize: 13, fontWeight: 600, transition: 'transform .25s', zIndex: 50,
          boxShadow: '0 12px 36px rgba(205,38,83,.32)',
          pointerEvents: 'none',
        }}
      >
        {toastMsg || ''}
      </div>

      <style jsx>{`
        @media (max-width: 768px) {
          .floor-drawer {
            position: fixed !important;
            inset: auto 0 0 0 !important;
            width: 100% !important;
            max-height: 62vh !important;
            border-left: 0 !important;
            border-top: 1px solid ${C.line} !important;
            border-radius: 18px 18px 0 0 !important;
            z-index: 40 !important;
          }
        }
      `}</style>
    </div>
  )
}

// ---------------- subcomponents ----------------
function LegendChip({ fill, stroke, dashed, label }: { fill: string; stroke: string; dashed?: boolean; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <i
        style={{
          display: 'inline-block', width: 11, height: 11, borderRadius: 3,
          background: fill,
          border: `1px ${dashed ? 'dashed' : 'solid'} ${stroke}`,
          verticalAlign: -1,
        }}
      />
      {label}
    </span>
  )
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '9px 0', borderBottom: `1px solid ${C.line}` }}>
      <b style={{ color: C.muted, fontWeight: 500 }}>{label}</b>
      <span style={{ textAlign: 'right', maxWidth: '60%' }}>{value}</span>
    </div>
  )
}

function BtnP({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: 0, borderRadius: 8, padding: 11, fontSize: 13, fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer', width: '100%',
        background: C.brand, color: '#fff', opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}
function BtnG({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${C.line}`, borderRadius: 8, padding: 11, fontSize: 13, fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer', width: '100%',
        background: C.panel2, color: C.text, opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}
function BtnD({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${C.brand2}40`, borderRadius: 8, padding: 11, fontSize: 13, fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer', width: '100%',
        background: 'transparent', color: C.brand2, opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}

function prettyType(t: FloorBooth['type']) {
  if (t === 'FS') return 'Full Space'
  if (t === 'TS') return 'Table Space'
  if (t === 'FT') return 'Food Truck'
  if (t === 'BS') return 'Bedouin Space'
  return 'Facility'
}
