// ── The physics of moving between machines ─────────────────────────────────
//
// Pure functions, so the feel can be tested without a browser: how far a pane
// follows the fingers, whether a release moves on or springs back, and the
// spring that carries it home.

/** A release past this share of the width moves on, however slow. */
export const COMMIT_DISTANCE = 0.3
/** A flick faster than this (px/ms) moves on even when short... */
export const FLICK_VELOCITY = 0.4
/** ...as long as it travelled at least this far (px), so a twitch does not. */
export const FLICK_MIN_DISTANCE = 24

/**
 * How far content moves when pulled `distance` past the last machine: it
 * gives a little and stiffens, never more than a fraction of `width`.
 */
export function rubberBand(distance: number, width: number): number {
  const limit = width * 0.12
  const sign = Math.sign(distance)
  const pulled = Math.abs(distance)
  return sign * limit * (1 - 1 / (pulled / limit * 0.55 + 1))
}

/**
 * Which way a release goes: +1 to the next machine, -1 to the previous one,
 * 0 back where it was. `offset` is how far the current pane has moved (negative
 * when it moved left, bringing in the next machine), `velocity` its speed, and
 * `projected` where the trackpad's momentum would carry it, so a swipe that
 * slows before the fingers lift still lands where it was headed.
 */
export function releaseDirection(
  offset: number,
  velocity: number,
  width: number,
  can: { previous: boolean; next: boolean },
  projected = offset,
): -1 | 0 | 1 {
  if (offset === 0) return 0
  const direction = offset < 0 ? 1 : -1
  if (direction === 1 ? !can.next : !can.previous) return 0
  const reach = Math.max(Math.abs(offset), Math.sign(projected) === Math.sign(offset) ? Math.abs(projected) : 0)
  const far = reach >= width * COMMIT_DISTANCE
  const flicked = Math.abs(offset) >= FLICK_MIN_DISTANCE
    && Math.abs(velocity) >= FLICK_VELOCITY
    && Math.sign(velocity) === Math.sign(offset)
  // A throw back toward the start cancels even a long pull.
  const thrownBack = Math.abs(velocity) >= FLICK_VELOCITY && Math.sign(velocity) === -Math.sign(offset)
  return (far && !thrownBack) || flicked ? direction : 0
}

/** Angular frequency of the settling spring: a full-width move rests in about a third of a second, without overshoot. */
const OMEGA = 26
const REST_DISTANCE = 1
const REST_VELOCITY = 0.02

export interface SpringState {
  /** Distance from the target, px. */
  position: number
  /** px/ms. */
  velocity: number
}

/**
 * Advance a critically damped spring pulling `state.position` to 0 by `dtMs`.
 * Critical damping arrives as fast as possible without bouncing past the edge,
 * the way a page settles into place.
 */
export function stepSpring(state: SpringState, dtMs: number): SpringState & { done: boolean } {
  const t = dtMs / 1000
  const x0 = state.position
  const v0 = state.velocity * 1000
  const decay = Math.exp(-OMEGA * t)
  const position = (x0 + (v0 + OMEGA * x0) * t) * decay
  const velocity = (v0 - OMEGA * (v0 + OMEGA * x0) * t) * decay
  const done = Math.abs(position) < REST_DISTANCE && Math.abs(velocity / 1000) < REST_VELOCITY
  return { position: done ? 0 : position, velocity: done ? 0 : velocity / 1000, done }
}

/**
 * Run a spring from `from` to `to` on animation frames, reporting each
 * position. Resolves when it rests; `cancel` stops it where it is.
 */
export function animateSpring(
  from: number,
  to: number,
  initialVelocity: number,
  onFrame: (value: number) => void,
): { done: Promise<void>; cancel: () => void } {
  let frame = 0
  let cancelled = false
  let resolve!: () => void
  const done = new Promise<void>((settle) => { resolve = settle })
  let state: SpringState = { position: from - to, velocity: initialVelocity }
  let last: number | null = null
  const tick = (now: number) => {
    if (cancelled) return
    // Frame times only; the first step is one frame long. A long gap (a hidden
    // tab) would teleport, so it steps as one frame too.
    const next = stepSpring(state, Math.min(Math.max(now - (last ?? now - 16), 0), 64))
    last = now
    state = next
    onFrame(to + next.position)
    if (next.done) resolve()
    else frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return {
    done,
    cancel: () => {
      cancelled = true
      cancelAnimationFrame(frame)
      resolve()
    },
  }
}
