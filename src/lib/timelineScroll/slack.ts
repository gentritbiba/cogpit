/**
 * Slack is estimated space the engine may resize freely: the top pad (history
 * reserve plus the rows rendered above the range) and the bottom slack after
 * the content. Moving layout changes into slack keeps what the reader looks at
 * in place without writing `scrollTop`.
 */

interface AbsorbInput {
  topPad: number
  /** How far the anchor moved down in content coordinates. */
  contentShift: number
  scrollTop: number
}

/** Cancels an anchor shift with the top pad, scrolling only by what the pad cannot hold. */
export function absorb({ topPad, contentShift, scrollTop }: AbsorbInput): { topPad: number; scrollTop: number } {
  const next = topPad - contentShift
  if (next >= 0) return { topPad: next, scrollTop }
  return { topPad: 0, scrollTop: scrollTop - next }
}

interface TargetInput {
  target: number
  scrollHeight: number
  clientHeight: number
  bottomSlack: number
}

/** Bottom slack needed so `target` is a reachable scroll position. */
export function slackForTarget({ target, scrollHeight, clientHeight, bottomSlack }: TargetInput): number {
  return bottomSlack + Math.max(0, target - (scrollHeight - clientHeight))
}

/** A decrease the browser made because the content got shorter, not because anyone scrolled. */
export function isClamp({ previous, current, maxScrollTop }: { previous: number; current: number; maxScrollTop: number }): boolean {
  return current < previous && current >= maxScrollTop - 1
}

/**
 * Moves the top pad to its target, shifting `scrollTop` by the same amount so
 * nothing visible moves. A pad shrinking by more than the scroll position is
 * itself on screen, so the content below it is allowed to move up into view.
 */
export function normalizeTop({ topPad, target, scrollTop }: { topPad: number; target: number; scrollTop: number }): { topPad: number; scrollTop: number } {
  return { topPad: target, scrollTop: Math.max(0, scrollTop + target - topPad) }
}

/**
 * Whether the top pad holds more than its target (history reserve plus the
 * rows above the range) and that excess, the pad's topmost part, is within a
 * viewport above the view. Nothing stands for that space, so reaching it
 * shows a blank screen; it cannot wait for scroll idle to be trimmed.
 */
export function excessNearView({ topPad, target, padTop, viewTop, viewport }: {
  topPad: number
  target: number
  /** Content offset of the pad's top edge. */
  padTop: number
  viewTop: number
  viewport: number
}): boolean {
  const excess = topPad - target
  return excess >= 1 && viewTop - viewport < padTop + excess
}

/** Bottom slack left after dropping the part below the viewport. */
export function trimBottomSlack({ bottomSlack, scrollHeight, scrollTop, clientHeight }: {
  bottomSlack: number
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): number {
  const below = Math.max(0, scrollHeight - scrollTop - clientHeight)
  return bottomSlack - Math.min(bottomSlack, below)
}
