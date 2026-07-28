/**
 * Where the draggable chat bubble sits, and how to keep it on screen.
 *
 * Taona 2026-07-28: the bubble covered the composer's Send button. The first fix
 * reserved 80px inside the composer, which narrowed the reply box for everyone,
 * forever, to work around an overlay that happened to be in the way once. His
 * call was better: "put it back and just make the chat thing moveable". The
 * person who can see the collision is the one who should resolve it, and it
 * costs the layout nothing.
 *
 * The arithmetic lives here because it is the part that silently breaks: a
 * position saved on a wide monitor and restored on a laptop puts the bubble off
 * the edge, where it cannot be dragged back.
 */

export const DOCK_SIZE = 56      // px, the w-14 h-14 button
export const DOCK_MARGIN = 24    // px, its original bottom-6 right-6 inset
export const DOCK_STORAGE_KEY = 'cth.chatDock.v1'

/** Distance a pointer must travel before a press counts as a drag, not a click. */
export const DRAG_THRESHOLD = 4

export interface DockPos { x: number; y: number }

/** Default: exactly where the bubble used to be hard-coded, bottom-right. */
export function defaultDock(vw: number, vh: number): DockPos {
  return {
    x: Math.max(DOCK_MARGIN, vw - DOCK_SIZE - DOCK_MARGIN),
    y: Math.max(DOCK_MARGIN, vh - DOCK_SIZE - DOCK_MARGIN),
  }
}

/**
 * Keep the whole button inside the viewport.
 *
 * Clamped on EVERY read, not just on drag, because the viewport that stored the
 * position is not always the viewport that restores it: a smaller window, a
 * rotated tablet, or an opened dev-tools pane would otherwise leave the bubble
 * parked outside the visible area with no way to reach it.
 */
export function clampDock(p: DockPos, vw: number, vh: number): DockPos {
  const maxX = Math.max(0, vw - DOCK_SIZE)
  const maxY = Math.max(0, vh - DOCK_SIZE)
  const x = Number.isFinite(p.x) ? p.x : 0
  const y = Number.isFinite(p.y) ? p.y : 0
  return {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY),
  }
}

/** Did the pointer move far enough that this was a drag rather than a click? */
export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > DRAG_THRESHOLD
}

/** Parse a stored position, tolerating anything at all in localStorage. */
export function parseDock(raw: string | null): DockPos | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return null
    const { x, y } = v as Partial<DockPos>
    if (typeof x !== 'number' || typeof y !== 'number') return null
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  } catch {
    return null
  }
}
