import { describe, expect, it } from "vitest"
import { COMMIT_DISTANCE, FLICK_MIN_DISTANCE, FLICK_VELOCITY, releaseDirection, rubberBand, stepSpring } from "../motion"

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

  it("moves on for a short flick, but not for a twitch", () => {
    expect(releaseDirection(-FLICK_MIN_DISTANCE, -FLICK_VELOCITY, WIDTH, both)).toBe(1)
    expect(releaseDirection(-FLICK_MIN_DISTANCE + 1, -FLICK_VELOCITY * 3, WIDTH, both)).toBe(0)
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

describe("stepSpring", () => {
  it("brings a full-width move to rest in about a third of a second without overshooting", () => {
    let state = { position: -WIDTH, velocity: 0 }
    let elapsed = 0
    let crossed = false
    for (; elapsed < 1000; elapsed += 8) {
      const next = stepSpring(state, 8)
      if (next.position > 0) crossed = true
      state = next
      if (next.done) break
    }
    expect(crossed).toBe(false)
    expect(state.position).toBe(0)
    expect(elapsed).toBeLessThan(450)
  })

  it("carries a throw's velocity", () => {
    const thrown = stepSpring({ position: -400, velocity: 2 }, 16)
    const still = stepSpring({ position: -400, velocity: 0 }, 16)
    expect(thrown.position).toBeGreaterThan(still.position)
  })

  it("never moves backwards in time", () => {
    expect(stepSpring({ position: -100, velocity: 0 }, 0).position).toBe(-100)
  })
})
