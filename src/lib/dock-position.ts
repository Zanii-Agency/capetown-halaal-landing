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

export const PANEL_W = 380
export const PANEL_H = 520
export const PANEL_GAP = 12   // breathing room between the bubble and the panel

/**
 * Where the chat panel opens, given where the bubble is.
 *
 * It follows the bubble, because a launcher you dragged to the left opening a
 * window on the far right is the panel ignoring you. The reason not to do this
 * naively is that the panel is large (380x520): anchored straight off a bubble
 * near an edge it would open half off-screen. So it is anchored AND clamped, and
 * flips to whichever side actually has room.
 *
 * Preference order, matching how every docked launcher behaves: above the
 * bubble and right-aligned with it, falling back to below when there is no room
 * above. Horizontal placement is then clamped rather than flipped, because a
 * panel that jumps left and right as you drag reads as broken.
 */
export function panelPosition(
  dock: DockPos,
  vw: number,
  vh: number,
): { left: number; top: number; width: number; height: number } {
  // The panel already shrinks on small viewports via max-w/max-h; mirror that
  // here or the maths places a 380px box inside a 320px window.
  const width = Math.min(PANEL_W, Math.max(0, vw - DOCK_MARGIN * 2))
  const height = Math.min(PANEL_H, Math.max(0, vh - DOCK_MARGIN * 2))

  // Right edge of the panel lines up with the right edge of the bubble.
  let left = dock.x + DOCK_SIZE - width
  // Above the bubble by default.
  let top = dock.y - height - PANEL_GAP

  // No room above: open below instead. Checked against the margin, not 0, so it
  // never sits flush against the window edge.
  if (top < DOCK_MARGIN) {
    const below = dock.y + DOCK_SIZE + PANEL_GAP
    // Only flip if below genuinely fits; otherwise stay above and let the clamp
    // do its job, which keeps the panel fully visible either way.
    if (below + height + DOCK_MARGIN <= vh) top = below
  }

  left = Math.min(Math.max(DOCK_MARGIN, left), Math.max(DOCK_MARGIN, vw - width - DOCK_MARGIN))
  top = Math.min(Math.max(DOCK_MARGIN, top), Math.max(DOCK_MARGIN, vh - height - DOCK_MARGIN))
  return { left, top, width, height }
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
