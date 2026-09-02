/**
 * Swipe-to-confirm geometry.
 *
 * Taona wanted the EFT lane's Remove action to be a swipe rather than a button:
 * "this should be a swipe within the button so everything looks straight",
 * confirmed as "yes swipe gesture". A swipe buys two things a button does not.
 * The row keeps a single fixed-width control so the action column stays a
 * straight edge down the table, and removing a vendor from the payment lane
 * stops being one stray click — the gesture IS the confirmation, so there is no
 * browser confirm() dialog to dismiss.
 *
 * The arithmetic lives here, away from React, because it is the part that can be
 * wrong in ways a screenshot will not show: a threshold that fires at the wrong
 * point, a progress value that escapes 0..1 and paints the handle outside its
 * track, or a divide-by-zero on a track that has not been measured yet.
 */

/**
 * How far along the track the handle must travel to count as confirmed.
 *
 * 0.85, not 1.0: a pointer released a few pixels short of a hard end should
 * still confirm, because the user's intent was unambiguous by then and
 * demanding the last 15% just makes the control feel broken. Not lower than
 * ~0.8 either, or a careless drag starts removing vendors from the lane.
 */
export const CONFIRM_AT = 0.85

/**
 * Fraction of the way across, clamped to 0..1.
 *
 * `travel` is the track width minus the handle width, i.e. the distance the
 * handle can actually move. Guarded against 0 because a track measured before
 * layout returns 0 and would otherwise produce Infinity or NaN, which React
 * happily writes into a style attribute.
 */
export function swipeProgress(deltaX: number, travel: number): number {
  if (!Number.isFinite(deltaX) || !Number.isFinite(travel) || travel <= 0) return 0
  const p = deltaX / travel
  if (Number.isNaN(p)) return 0
  return Math.min(1, Math.max(0, p))
}

/** Whether a release at this progress should fire the action. */
export function isConfirmed(progress: number): boolean {
  return progress >= CONFIRM_AT
}
