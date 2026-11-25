import { describe, expect, it } from "vitest"
import { COMMIT_DISTANCE, FLICK_MIN_SHARE, FLICK_VELOCITY, releaseDirection, rubberBand, springAt, springFrames } from "../motion"

const WIDTH = 1000
const both = { previous: true, next: true }

describe("releaseDirection", () => {
  it("moves on once the pane went far enough, whichever way", () => {
    expect(releaseDirection(-WIDTH * COMMIT_DISTANCE, 0, WIDTH, both)).toBe(1)
    expect(releaseDirection(WIDTH * COMMIT_DISTANCE, 0, WIDTH, both)).toBe(-1)
  })

  it("springs back from a short, slow pull", () => {
    expect(releaseDirection(-WIDTH * COMMIT_DISTANCE + 1, 0, WIDTH, both)).toBe(0)
  })

  it("moves on for a short flick, but not for a light brush, however quick", () => {
    expect(releaseDirection(-WIDTH * FLICK_MIN_SHARE, -FLICK_VELOCITY, WIDTH, both)).toBe(1)
    expect(releaseDirection(-WIDTH * FLICK_MIN_SHARE + 1, -FLICK_VELOCITY * 3, WIDTH, both)).toBe(0)
    expect(releaseDirection(-WIDTH * FLICK_MIN_SHARE * 2, -FLICK_VELOCITY + 0.05, WIDTH, both)).toBe(0)
  })

  it("lands where a swipe that slowed before the fingers lifted was headed", () => {
    expect(releaseDirection(-WIDTH * 0.2, -0.1, WIDTH, both, -WIDTH * 0.35)).toBe(1)
    expect(releaseDirection(-WIDTH * 0.2, -0.1, WIDTH, both, -WIDTH * 0.25)).toBe(0)
  })

  it("cancels a long pull thrown back toward where it started", () => {
    expect(releaseDirection(-WIDTH * 0.6, FLICK_VELOCITY, WIDTH, both)).toBe(0)
  })

  it("stays put when there is no machine on that side", () => {
    expect(releaseDirection(-WIDTH * 0.9, -2, WIDTH, { previous: true, next: false })).toBe(0)
    expect(releaseDirection(WIDTH * 0.9, 2, WIDTH, { previous: false, next: true })).toBe(0)
  })
})

describe("rubberBand", () => {
  it("gives a little, never more than a fraction of the width, and keeps the sign", () => {
    const near = rubberBand(-50, WIDTH)
    const far = rubberBand(-5000, WIDTH)
    expect(near).toBeLessThan(0)
    expect(Math.abs(near)).toBeLessThan(50)
    expect(Math.abs(far)).toBeGreaterThan(Math.abs(near))
    expect(Math.abs(far)).toBeLessThan(WIDTH * 0.12)
    expect(rubberBand(50, WIDTH)).toBe(-near)
  })
})

describe("the settling spring", () => {
  /** How far off the target the spring is after `ms`, from its keyframes. */
  const at = (frames: { duration: number; distances: number[] }, ms: number) =>
    frames.distances[Math.min(frames.distances.length - 1, Math.round(ms / (frames.duration / (frames.distances.length - 1))))]

  it("covers most of a full width in a tenth of a second and rests within a third, without overshooting", () => {
    const frames = springFrames(-WIDTH, 0)
    expect(frames.duration).toBeLessThan(340)
    expect(Math.abs(at(frames, 112))).toBeLessThan(WIDTH * 0.12)
    expect(frames.distances.every((distance) => distance <= 0)).toBe(true)
    expect(frames.distances.at(-1)).toBe(0)
  })

  it("brings a slight pull back almost at once", () => {
    const frames = springFrames(80, 0)
    expect(Math.abs(at(frames, 104))).toBeLessThan(12)
    expect(frames.duration).toBeLessThan(260)
  })

  it("carries a throw's velocity", () => {
    expect(springAt(-400, 2, 16).distance).toBeGreaterThan(springAt(-400, 0, 16).distance)
  })

  it("has nothing to play when it is already at rest", () => {
    expect(springFrames(0, 0)).toEqual({ duration: 0, distances: [0] })
  })

  it("never moves backwards in time", () => {
    expect(springAt(-100, 0, -5).distance).toBe(-100)
  })
})
