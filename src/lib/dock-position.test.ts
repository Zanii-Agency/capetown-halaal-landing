import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultDock, clampDock, isDrag, parseDock, panelPosition,
  DOCK_SIZE, DOCK_MARGIN, DRAG_THRESHOLD, PANEL_GAP,
} from './dock-position'

test('the default position is exactly where the bubble used to be hard-coded', () => {
  // bottom-6 right-6 on a 1440x900 viewport.
  assert.deepEqual(defaultDock(1440, 900), {
    x: 1440 - DOCK_SIZE - DOCK_MARGIN,
    y: 900 - DOCK_SIZE - DOCK_MARGIN,
  })
})

test('a position saved on a big screen is pulled back onto a small one', () => {
  // THE BUG THIS PREVENTS: parked at x=1850 on a wide monitor, reopened on a
  // 1280px laptop, the bubble would sit off-screen and could never be dragged
  // back, because you cannot grab what you cannot see.
  const rescued = clampDock({ x: 1850, y: 1200 }, 1280, 800)
  assert.equal(rescued.x, 1280 - DOCK_SIZE)
  assert.equal(rescued.y, 800 - DOCK_SIZE)
})

test('clamping keeps the WHOLE button visible, not just its origin', () => {
  const p = clampDock({ x: 99999, y: 99999 }, 1000, 600)
  assert.ok(p.x + DOCK_SIZE <= 1000)
  assert.ok(p.y + DOCK_SIZE <= 600)
})

test('negative and non-finite positions are recovered, never propagated', () => {
  assert.deepEqual(clampDock({ x: -50, y: -50 }, 1000, 600), { x: 0, y: 0 })
  // NaN and Infinity both resolve to 0, deliberately and identically. Reading
  // Infinity as "pin it to the far edge" would be interpreting garbage as
  // intent; a coordinate that is not a number carries no intent at all, so it
  // resolves to a known-visible position instead.
  assert.deepEqual(clampDock({ x: NaN, y: 10 }, 1000, 600), { x: 0, y: 10 })
  assert.deepEqual(clampDock({ x: Infinity, y: 10 }, 1000, 600), { x: 0, y: 10 })
  assert.deepEqual(clampDock({ x: -Infinity, y: 10 }, 1000, 600), { x: 0, y: 10 })
})

test('a viewport smaller than the button does not produce a negative bound', () => {
  const p = clampDock({ x: 10, y: 10 }, 40, 30)
  assert.deepEqual(p, { x: 0, y: 0 })
})

test('a tap is a click, a real move is a drag', () => {
  // The bubble must still OPEN on click. A press that wobbles a pixel or two,
  // which every real tap does, must not be swallowed as a drag.
  assert.equal(isDrag(0, 0), false, 'a clean tap')
  assert.equal(isDrag(2, 2), false, 'a wobbly tap')
  assert.equal(isDrag(DRAG_THRESHOLD, 0), false, 'exactly at the threshold is still a tap')
  assert.equal(isDrag(20, 0), true, 'a deliberate drag')
  assert.equal(isDrag(0, -30), true, 'dragging upward counts too')
})

test('a corrupt stored position is ignored rather than crashing the widget', () => {
  for (const raw of [null, '', 'not json', '{]', '{"x":"a","y":2}', '{"x":1}', 'null', '[1,2]', '{"x":null,"y":1}']) {
    assert.equal(parseDock(raw), null, `input: ${JSON.stringify(raw)}`)
  }
})

test('a valid stored position round-trips', () => {
  assert.deepEqual(parseDock(JSON.stringify({ x: 12, y: 34 })), { x: 12, y: 34 })
})

// ---------------------------------------------------------------------------
// The panel follows the bubble. A launcher dragged to the left that opens its
// window on the far right is the panel ignoring you.
// ---------------------------------------------------------------------------

test('the panel opens above the bubble, right-aligned with it', () => {
  const p = panelPosition({ x: 1000, y: 700 }, 1440, 900)
  assert.equal(p.left + p.width, 1000 + DOCK_SIZE, 'right edges line up')
  assert.equal(p.top + p.height + PANEL_GAP, 700, 'sits just above the bubble')
})

test('the panel moves WITH the bubble rather than staying put', () => {
  const right = panelPosition({ x: 1300, y: 700 }, 1440, 900)
  const left = panelPosition({ x: 120, y: 700 }, 1440, 900)
  assert.notEqual(right.left, left.left, 'dragging the bubble left moves the panel left')
  assert.ok(left.left < right.left)
})

test('a bubble near the top opens the panel BELOW instead of off-screen', () => {
  const p = panelPosition({ x: 1000, y: 30 }, 1440, 900)
  assert.ok(p.top >= 30 + DOCK_SIZE, 'flipped to below the bubble')
  assert.ok(p.top + p.height <= 900, 'and still fits')
})

test('the panel is always fully on screen, wherever the bubble is', () => {
  // The whole reason this is not a naive offset: anchored straight off a bubble
  // in any corner, a 380x520 panel would hang off the edge.
  for (const dock of [
    { x: 0, y: 0 }, { x: 1384, y: 0 }, { x: 0, y: 844 }, { x: 1384, y: 844 },
    { x: 700, y: 400 },
  ]) {
    const p = panelPosition(dock, 1440, 900)
    assert.ok(p.left >= 0, `left ${p.left}`)
    assert.ok(p.top >= 0, `top ${p.top}`)
    assert.ok(p.left + p.width <= 1440, `right edge ${p.left + p.width}`)
    assert.ok(p.top + p.height <= 900, `bottom edge ${p.top + p.height}`)
  }
})

test('on a viewport smaller than the panel it shrinks instead of overflowing', () => {
  const p = panelPosition({ x: 10, y: 10 }, 320, 480)
  assert.ok(p.width <= 320, 'narrower than the window')
  assert.ok(p.height <= 480, 'shorter than the window')
  assert.ok(p.left + p.width <= 320)
  assert.ok(p.top + p.height <= 480)
})
