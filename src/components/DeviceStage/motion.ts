// ── The physics of moving between machines ─────────────────────────────────
//
// Pure functions, so the feel can be tested without a browser: how far a pane
// follows the fingers, whether a release moves on or springs back, and the
// spring that carries it home.

/** A release past this share of the width moves on, however slow. */
export const COMMIT_DISTANCE = 0.3
/** A flick faster than this (px/ms) moves on even when short... */
export const FLICK_VELOCITY = 0.6
/** ...as long as it travelled at least this share of the width, so a light brush does not. */
export const FLICK_MIN_SHARE = 0.08

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
  const flicked = Math.abs(offset) >= width * FLICK_MIN_SHARE
    && Math.abs(velocity) >= FLICK_VELOCITY
    && Math.sign(velocity) === Math.sign(offset)
  // A throw back toward the start cancels even a long pull.
  const thrownBack = Math.abs(velocity) >= FLICK_VELOCITY && Math.sign(velocity) === -Math.sign(offset)
  return (far && !thrownBack) || flicked ? direction : 0
}

/**
 * Angular frequency of the settling spring (rad/s). Critically damped, it
 * covers nine tenths of any distance in about a tenth of a second and never
 * overshoots; the rest is a short glide into place.
 */
const OMEGA = 34
/** Close enough to call it at rest (px), and slow enough (px/ms). */
const REST_DISTANCE = 0.5
const REST_VELOCITY = 0.05
const MAX_DURATION_MS = 600
/** One keyframe per this many ms: finer than any display refreshes. */
const FRAME_MS = 8

/**
 * Where a critically damped spring released `distance` px from its target,
 * moving at `velocity` px/ms, is after `ms`, and how fast it moves then.
 */
export function springAt(distance: number, velocity: number, ms: number): { distance: number; velocity: number } {
  const t = Math.max(0, ms) / 1000
  const v0 = velocity * 1000
  const decay = Math.exp(-OMEGA * t)
  return {
    distance: (distance + (v0 + OMEGA * distance) * t) * decay,
    velocity: (v0 - OMEGA * (v0 + OMEGA * distance) * t) * decay / 1000,
  }
}

/**
 * The spring from `distance` px off its target to rest, sampled every
 * FRAME_MS for keyframes the compositor can play without the main thread:
 * `distances[0]` is the start, the last is 0, and `duration` spans them.
 */
export function springFrames(distance: number, velocity: number): { duration: number; distances: number[] } {
  if (Math.abs(distance) < REST_DISTANCE && Math.abs(velocity) < REST_VELOCITY) return { duration: 0, distances: [0] }
  const distances = [distance]
  let ms = 0
  for (;;) {
    ms += FRAME_MS
    const state = springAt(distance, velocity, ms)
    const resting = Math.abs(state.distance) < REST_DISTANCE && Math.abs(state.velocity) < REST_VELOCITY
    if (resting || ms >= MAX_DURATION_MS) break
    distances.push(state.distance)
  }
  distances.push(0)
  return { duration: (distances.length - 1) * FRAME_MS, distances }
}
