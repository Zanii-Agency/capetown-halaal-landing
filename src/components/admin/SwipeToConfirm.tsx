'use client'

/**
 * Drag the handle across the track to fire a destructive action.
 *
 * Taona, 2026-07-27: "this should be a swipe within the button so everything
 * looks straight", confirmed 2026-07-28 as "yes swipe gesture". An earlier pass
 * misread that as button ALIGNMENT and shipped fixed-width slots; this is the
 * control he actually asked for.
 *
 * Two reasons it is a swipe and not a button. The row keeps one fixed-width
 * control, so the action column stays a straight edge down the table. And the
 * gesture IS the confirmation: removing a vendor from the payment lane is not
 * something a stray click should achieve, so there is no confirm() dialog
 * stacked on top of it.
 *
 * POINTER EVENTS, NOT MOUSE + TOUCH. One code path covers mouse, trackpad, touch
 * and pen, and setPointerCapture keeps the drag alive when the pointer leaves
 * the track — which is exactly what happens when someone flicks it.
 *
 * IT IS NOT GESTURE-ONLY. A control reachable only by dragging is unusable by
 * keyboard and by anyone with a motor impairment, and this is the ONLY route to
 * the action. So it is a real <button>: Enter or Space arms it, a second press
 * commits, and it disarms itself after a few seconds so a one-keypress delete is
 * never left sitting there.
 *
 * PROGRESS LIVES IN A REF AS WELL AS STATE. The commit decision reads the ref,
 * never a setState updater — an updater must be pure, and React StrictMode
 * double-invokes it, which would have fired onConfirm twice and removed the
 * vendor twice.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, ChevronsRight, Check } from 'lucide-react'
import { swipeProgress, isConfirmed } from '@/lib/swipe'

const HANDLE = 26 // px; keep in sync with the handle's h/w below
const INSET = 2   // px of padding at each end of the track
const ARM_MS = 3000

export function SwipeToConfirm({
  onConfirm,
  busy = false,
  label = 'Swipe to remove',
  armedLabel = 'Press again to confirm',
  busyLabel = 'Removing',
  ariaLabel,
}: {
  onConfirm: () => void
  busy?: boolean
  label?: string
  armedLabel?: string
  busyLabel?: string
  ariaLabel: string
}) {
  const track = useRef<HTMLDivElement>(null)
  const startX = useRef(0)
  const progressRef = useRef(0)
  const [progress, setProgress] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [armed, setArmed] = useState(false)

  const set = useCallback((p: number) => { progressRef.current = p; setProgress(p) }, [])

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), ARM_MS)
    return () => clearTimeout(t)
  }, [armed])

  // Reset when the action finishes, so a failed remove leaves a usable control
  // rather than one stuck at 100%.
  useEffect(() => { if (!busy) set(0) }, [busy, set])

  /** Distance the handle can actually travel: track width minus handle and insets. */
  const travel = () =>
    Math.max(0, (track.current?.getBoundingClientRect().width ?? 0) - HANDLE - INSET * 2)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (busy) return
    e.currentTarget.setPointerCapture(e.pointerId)
    startX.current = e.clientX
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || busy) return
    set(swipeProgress(e.clientX - startX.current, travel()))
  }

  const release = () => {
    if (!dragging) return
    setDragging(false)
    if (isConfirmed(progressRef.current)) { set(1); onConfirm() } else { set(0) }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (busy || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    if (armed) { setArmed(false); onConfirm() } else { setArmed(true) }
  }

  const pct = Math.round(progress * 100)
  const hot = busy || armed || progress > 0

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      onBlur={() => setArmed(false)}
      className="relative block w-full select-none rounded-lg text-left disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#cd2653]/40"
    >
      <div
        ref={track}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        style={{ touchAction: 'none' }}
        className={`relative h-[30px] w-full overflow-hidden rounded-lg border transition-colors ${
          hot ? 'border-[#cd2653]/40 bg-[#cd2653]/[0.06]' : 'border-neutral-200 bg-neutral-50'
        }`}
      >
        {/* Fill trails the handle, so the control reads as "how far along am I". */}
        <div
          className="absolute inset-y-0 left-0 bg-[#cd2653]/15"
          style={{ width: `${pct}%`, transition: dragging ? 'none' : 'width 160ms ease-out' }}
        />
        <span
          className={`pointer-events-none absolute inset-0 flex items-center justify-center px-7 text-center text-[11px] font-semibold ${
            hot ? 'text-[#cd2653]' : 'text-[#1B1A17]/45'
          }`}
        >
          {busy ? busyLabel : armed ? armedLabel : label}
        </span>
        <div
          className="absolute flex items-center justify-center rounded-md border border-neutral-200 bg-white shadow-sm"
          style={{
            height: HANDLE,
            width: HANDLE,
            top: '50%',
            // Unitless progress against a percentage span: valid calc, and it
            // keeps the handle inside the track at both ends.
            left: `calc(${INSET}px + ${progress} * (100% - ${HANDLE + INSET * 2}px))`,
            transform: 'translateY(-50%)',
            transition: dragging ? 'none' : 'left 160ms ease-out',
            cursor: busy ? 'default' : 'grab',
          }}
        >
          {busy
            ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[#cd2653]" />
            : progress === 1
              ? <Check className="h-3.5 w-3.5 text-[#cd2653]" />
              : <ChevronsRight className="h-3.5 w-3.5 text-[#1B1A17]/40" />}
        </div>
      </div>
    </button>
  )
}
